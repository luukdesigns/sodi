import { type Address, type Hex, type PublicClient, type WalletClient, encodeAbiParameters, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { depositedEvent, entrypointAbi, erc20Abi, findDeposit, findWithdrawal, latestAspRoot, poolAbi, stateTreeLeaves } from './chain.js';
import {
  type MasterKeys,
  commitmentHash,
  depositSecrets,
  generateMasterKeys,
  merkleProof,
  nullifierHash,
  precommitmentHash,
  sessionPrivateKey,
  withdrawalContext,
  withdrawalSecrets,
} from './crypto.js';
import type { WithdrawalProver } from './prover.js';
import type { Relayer } from './relayer.js';
import type { PoolNote, Session, Store, WalletState } from './store.js';

export interface PoolWalletConfig {
  publicClient: PublicClient;
  /** Owner wallet, used only for public deposits into the pool. */
  ownerWallet?: WalletClient;
  /** Mnemonic the pool secrets are derived from. Keep it as safe as a wallet seed. */
  mnemonic: string;
  entrypoint: Address;
  pool: Address;
  asset: Address;
  /** Block the pool was deployed at, where state-tree scanning starts. */
  poolDeploymentBlock: bigint;
  relayer: Relayer;
  prover: WithdrawalProver;
  /** Approved labels of the current association set, e.g. from the Sodi approval service. */
  associationSet: () => Promise<bigint[]>;
  store: Store;
  now?: () => number;
}

/** A withdrawal from the pool to an address the wallet doesn't hold the key for. */
export interface Funding {
  address: Address;
  /** What the address received, after the relayer's fee. */
  received: bigint;
  fundingTx: Hex;
}

/** A withdrawal of one of our notes, as found on-chain. */
interface Observed {
  label: string;
  spendIndex: number;
  recipient?: Address;
  received: bigint;
  txHash: Hex;
}

/**
 * The pool side of rx402: holds the mnemonic, deposits, and funds sessions with zero-knowledge
 * withdrawals. Whoever has the mnemonic can withdraw the whole pool, so this belongs with the owner.
 * Run it inside the agent only if the agent's machine is trusted with everything in the pool;
 * otherwise run it as a session issuer and give the agent only an agent key.
 */
export class PoolWallet {
  private readonly keys: MasterKeys;
  private scope?: bigint;

  constructor(private readonly config: PoolWalletConfig) {
    this.keys = generateMasterKeys(config.mnemonic);
  }

  private now(): number {
    return this.config.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private async getScope(): Promise<bigint> {
    this.scope ??= await this.config.publicClient.readContract({ address: this.config.pool, abi: poolAbi, functionName: 'SCOPE' });
    return this.scope;
  }

  private queue: Promise<unknown> = Promise.resolve();

  /** One withdrawal or deposit at a time, so the notes can't race. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  get canDeposit(): boolean {
    return Boolean(this.config.ownerWallet?.account);
  }

  /** Total value still in the pool across all notes, as of the last sync. */
  poolBalance(): bigint {
    return this.config.store.load().notes.reduce((sum, n) => sum + BigInt(n.value), 0n);
  }

  // ---------------------------------------------------------------- deposits

  /** Deposits `amount` of the asset from the owner wallet. This step is public. */
  deposit(amount: bigint): Promise<PoolNote> {
    return this.exclusive(() => this.depositLocked(amount));
  }

  private async depositLocked(amount: bigint): Promise<PoolNote> {
    const { ownerWallet, publicClient, entrypoint, asset, store } = this.config;
    if (!ownerWallet?.account) throw new Error('ownerWallet is required to deposit');
    const scope = await this.getScope();
    let state = store.load();
    const index = state.depositCounts[scope.toString()] ?? 0;
    const secrets = depositSecrets(this.keys, scope, BigInt(index));
    // Reserve the index first, so a crash after sending can never reuse these secrets.
    state.depositCounts[scope.toString()] = index + 1;
    store.save(state);

    const allowance = await publicClient.readContract({
      address: asset,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [ownerWallet.account.address, entrypoint],
    });
    if (allowance < amount) {
      const approveTx = await ownerWallet.writeContract({
        address: asset,
        abi: erc20Abi,
        functionName: 'approve',
        args: [entrypoint, amount],
        account: ownerWallet.account,
        chain: ownerWallet.chain,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
    }

    const depositTx = await ownerWallet.writeContract({
      address: entrypoint,
      abi: entrypointAbi,
      functionName: 'deposit',
      args: [asset, amount, precommitmentHash(secrets)],
      account: ownerWallet.account,
      chain: ownerWallet.chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: depositTx });
    if (receipt.status !== 'success') throw new Error(`deposit reverted: ${depositTx}`);

    const [event] = parseEventLogs({ abi: [depositedEvent], logs: receipt.logs }).filter(
      (l) => l.address.toLowerCase() === this.config.pool.toLowerCase(),
    );
    if (!event) throw new Error('Deposited event not found');
    const { _label: label, _value: value, _commitment: commitment } = event.args;
    if (commitmentHash(value, label, secrets) !== commitment) {
      throw new Error('on-chain commitment does not match locally derived secrets');
    }

    const note: PoolNote = {
      scope: scope.toString(),
      depositIndex: index,
      label: label.toString(),
      value: value.toString(),
      spendCount: 0,
      depositTx,
    };
    state = store.load();
    state.notes.push(note);
    store.save(state);
    return note;
  }

  /** Re-adds deposits that landed on-chain but whose note was never saved (e.g. a crash). */
  private async recoverDeposits(state: WalletState): Promise<boolean> {
    const scope = await this.getScope();
    const count = state.depositCounts[scope.toString()] ?? 0;
    let changed = false;
    for (let i = 0; i < count; i++) {
      if (state.notes.some((n) => n.scope === scope.toString() && n.depositIndex === i)) continue;
      const secrets = depositSecrets(this.keys, scope, BigInt(i));
      const d = await findDeposit(this.config.publicClient, this.config.pool, this.config.poolDeploymentBlock, precommitmentHash(secrets));
      if (!d || commitmentHash(d.value, d.label, secrets) !== d.commitment) continue;
      state.notes.push({ scope: scope.toString(), depositIndex: i, label: d.label.toString(), value: d.value.toString(), spendCount: 0, depositTx: d.txHash });
      changed = true;
    }
    return changed;
  }

  /**
   * Brings the store in line with the chain. Withdrawals are recorded only once they are confirmed
   * on-chain, and session keys are derived from the mnemonic, so whatever happened before (a relayer
   * that failed after broadcasting, a crash, a relayer that held a proof and landed it later), the
   * notes and sessions can be rebuilt here. Returns the withdrawals it found.
   */
  private async syncNotes(state: WalletState): Promise<Observed[]> {
    const { publicClient, pool, entrypoint, poolDeploymentBlock } = this.config;
    const found: Observed[] = [];
    for (const note of state.notes) {
      for (;;) {
        const label = BigInt(note.label);
        const existing = this.noteSecrets(note);
        const spent = await publicClient.readContract({ address: pool, abi: poolAbi, functionName: 'nullifierHashes', args: [nullifierHash(existing.nullifier)] });
        if (!spent) break;
        const w = await findWithdrawal(publicClient, pool, entrypoint, poolDeploymentBlock, nullifierHash(existing.nullifier));
        if (!w) throw new Error(`deposit ${note.label} was spent but its withdrawal was not found; check the RPC`);
        const key = sessionPrivateKey(this.keys, label, BigInt(note.spendCount));
        const address = privateKeyToAccount(key).address;
        const remaining = BigInt(note.value) - w.value;
        if (commitmentHash(remaining, label, withdrawalSecrets(this.keys, label, BigInt(note.spendCount))) !== w.newCommitment) {
          throw new Error(`withdrawal ${w.txHash} spent deposit ${note.label} but its change commitment does not match; was this mnemonic used elsewhere?`);
        }
        const received = w.received ?? w.value;
        if (!state.sessions.some((s) => s.address === address) && w.recipient?.toLowerCase() === address.toLowerCase()) {
          state.sessions.push({ address, privateKey: key, budget: received.toString(), spent: '0', payments: 0, openedAt: this.now(), fundingTx: w.txHash });
        }
        found.push({ label: note.label, spendIndex: note.spendCount, recipient: w.recipient, received, txHash: w.txHash });
        note.value = remaining.toString();
        note.spendCount += 1;
      }
    }
    return found;
  }

  private noteSecrets(note: PoolNote) {
    return note.spendCount === 0
      ? depositSecrets(this.keys, BigInt(note.scope), BigInt(note.depositIndex))
      : withdrawalSecrets(this.keys, BigInt(note.label), BigInt(note.spendCount - 1));
  }

  /** Re-reads deposits and withdrawals from the chain and saves the result. */
  sync(): Promise<void> {
    return this.exclusive(async () => {
      const state = this.config.store.load();
      const recovered = await this.recoverDeposits(state);
      if ((await this.syncNotes(state)).length || recovered) this.config.store.save(state);
    });
  }

  /**
   * Withdraws `budget` to a fresh session address derived from the mnemonic, via the relayer, with a
   * zero-knowledge proof. The withdrawal reveals the amount and the address, not which deposit it
   * came from.
   */
  openSession(budget: bigint): Promise<Session> {
    return this.exclusive(async () => {
      const r = await this.withdrawLocked(budget);
      if (!('session' in r)) throw new Error('unreachable');
      return r.session;
    });
  }

  /**
   * Withdraws `budget` to an address someone else holds the key for, such as a session address an
   * agent derived from its own key. Used by the session issuer.
   */
  fund(budget: bigint, recipient: Address): Promise<Funding> {
    return this.exclusive(async () => {
      const r = await this.withdrawLocked(budget, recipient);
      if (!('funding' in r)) throw new Error('unreachable');
      return r.funding;
    });
  }

  private async withdrawLocked(budget: bigint, recipient?: Address): Promise<{ session: Session } | { funding: Funding }> {
    const { publicClient, entrypoint, pool, relayer, prover, store } = this.config;
    if (budget <= 0n) throw new Error('budget must be positive');

    let state = store.load();
    const recovered = await this.recoverDeposits(state);
    if ((await this.syncNotes(state)).length || recovered) store.save(state);

    const approved = await this.config.associationSet();
    const approvedSet = new Set(approved.map(String));
    const note = state.notes.find((n) => BigInt(n.value) >= budget && approvedSet.has(n.label));
    if (!note) {
      const any = state.notes.some((n) => BigInt(n.value) >= budget);
      throw new Error(any ? 'no approved pool deposit yet; wait for the approval service' : `no pool deposit with at least ${budget} available; deposit more`);
    }

    const scope = await this.getScope();
    const label = BigInt(note.label);
    const spendIndex = note.spendCount;
    const existingValue = BigInt(note.value);
    const existing = this.noteSecrets(note);
    const next = withdrawalSecrets(this.keys, label, BigInt(spendIndex));

    // Inclusion proofs: the note is in the pool's state tree, and its label is approved.
    const leaves = await stateTreeLeaves(publicClient, pool, this.config.poolDeploymentBlock);
    const stateProof = merkleProof(leaves, commitmentHash(existingValue, label, existing));
    const aspProof = merkleProof(approved, label);
    const onChainAsp = await latestAspRoot(publicClient, entrypoint);
    if (aspProof.root !== onChainAsp) {
      throw new Error('association set does not match the on-chain root; is the approval service in sync?');
    }

    const target = recipient ?? privateKeyToAccount(sessionPrivateKey(this.keys, label, BigInt(spendIndex))).address;
    const withdrawal = {
      processooor: entrypoint,
      data: encodeAbiParameters(
        [{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] }],
        [[target, relayer.feeRecipient, relayer.relayFeeBPS]],
      ),
    };

    const { proof } = await prover.prove({
      withdrawnValue: budget,
      stateProof,
      aspProof,
      context: withdrawalContext(withdrawal, scope),
      label,
      existingValue,
      existing,
      next,
    });

    // Nothing is saved until the chain confirms the withdrawal, whatever the relayer reports.
    let relayError: unknown;
    try {
      const hash = await relayer.relay(withdrawal, proof, scope);
      await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 }).catch(() => undefined);
    } catch (err) {
      relayError = err;
    }
    state = store.load();
    const found = await this.syncNotes(state);
    store.save(state);
    const landed = found.find((w) => w.label === note.label && w.spendIndex === spendIndex);
    if (!landed) {
      throw new Error(
        `the session withdrawal did not land${relayError ? `: ${(relayError as Error).message}` : ' (the relayer reported a transaction the chain does not show)'}`,
      );
    }
    if (landed.recipient?.toLowerCase() !== target.toLowerCase()) {
      throw new Error(`withdrawal ${landed.txHash} paid ${landed.recipient}, not ${target}`);
    }
    if (recipient) return { funding: { address: recipient, received: landed.received, fundingTx: landed.txHash } };

    const session = state.sessions.find((s) => s.address === target);
    if (!session) throw new Error('session withdrawal landed but was not recorded');
    return { session };
  }
}
