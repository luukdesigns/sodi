import { type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient, encodeAbiParameters, parseAbi, parseEventLogs } from 'viem';

const routerAbi = parseAbi(['function deposit(uint256 assets, uint256 precommitment) returns (uint256 commitment)']);
import { privateKeyToAccount } from 'viem/accounts';

import { depositedEvent, entrypointAbi, erc20Abi, findDeposit, findRagequit, findWithdrawal, funderAbi, latestAspRoot, poolAbi, stateTreeLeaves, vaultAbi } from './chain.js';
import {
  type MasterKeys,
  type Withdrawal,
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
import type { RagequitProver, RagequitSolidityProof, SolidityProof, WithdrawalProver } from './prover.js';
import { type RecycleSubmitter, type TokenDomain, USDG_DOMAIN, recycleFrom } from './recycle.js';
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
  /** USDG: what goes in and what sessions receive. */
  asset: Address;
  /**
   * The yield pool. Its asset is the yield vault's share, which only exists inside the pool, so
   * deposits go in as USDG through the router and sessions come out as USDG through the funder.
   * Notes and withdrawals are then counted in shares; session budgets stay in USDG.
   */
  yieldPool?: { vault: Address; router: Address; funder: Address };
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

  /** Margin of extra shares withdrawn for a yield-pool session, so price drift can't leave it short. */
  static readonly YIELD_MARGIN_BPS = 1n;

  get canDeposit(): boolean {
    return Boolean(this.config.ownerWallet?.account);
  }

  /** Total value still in the pool across all notes, as of the last sync. */
  poolBalance(): bigint {
    return this.config.store.load().notes.reduce((sum, n) => sum + BigInt(n.value), 0n);
  }

  // ---------------------------------------------------------------- deposits

  /**
   * Deposits `amount` from the owner wallet: of the pool's asset, or with a router, of USDG, which the
   * router turns into yield-vault shares. This step is public.
   */
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

    const router = this.config.yieldPool ? { address: this.config.yieldPool.router } : undefined;
    const token = asset;
    const spender = router ? router.address : entrypoint;
    const allowance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [ownerWallet.account.address, spender],
    });
    if (allowance < amount) {
      const approveTx = await ownerWallet.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, amount],
        account: ownerWallet.account,
        chain: ownerWallet.chain,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
    }

    const depositTx = router
      ? await ownerWallet.writeContract({
          address: router.address,
          abi: routerAbi,
          functionName: 'deposit',
          args: [amount, precommitmentHash(secrets)],
          account: ownerWallet.account,
          chain: ownerWallet.chain,
          gas: ((await publicClient.estimateContractGas({ address: router.address, abi: routerAbi, functionName: 'deposit', args: [amount, precommitmentHash(secrets)], account: ownerWallet.account })) * 13n) / 10n,
        })
      : await ownerWallet.writeContract({
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

  /**
   * Reserves the next deposit's secrets for a deposit made somewhere else, such as an agent recycling
   * a session through a session issuer. Returns its precommitment; the note is picked up from the
   * chain by the next sync.
   */
  reservePrecommitment(): Promise<bigint> {
    return this.exclusive(async () => {
      const scope = await this.getScope();
      const state = this.config.store.load();
      const index = state.depositCounts[scope.toString()] ?? 0;
      state.depositCounts[scope.toString()] = index + 1;
      this.config.store.save(state);
      return precommitmentHash(depositSecrets(this.keys, scope, BigInt(index)));
    });
  }

  /** Deposits reserved (or sent) whose note hasn't been found on-chain yet, as of the last sync. */
  async pendingReservations(): Promise<number> {
    const scope = (await this.getScope()).toString();
    const state = this.config.store.load();
    return (state.depositCounts[scope] ?? 0) - state.notes.filter((n) => n.scope === scope).length;
  }

  /**
   * Moves everything `account` holds back into the pool as a new deposit of this wallet's, through
   * the SodiRecycler: `account` signs, `submitter` sends the transaction, so `account` needs no gas.
   * Works for any address whose key you hold: an old session, or a merchant's stealth address.
   *
   * The recycle itself is public (this address put this amount into the pool); like any deposit, what
   * happens to it afterwards isn't.
   */
  recycle(account: LocalAccount, submitter: RecycleSubmitter, opts: { domain?: TokenDomain; value?: bigint } = {}): Promise<PoolNote> {
    return this.exclusive(async () => {
      const { publicClient, store, pool, asset } = this.config;
      const value = opts.value ?? (await publicClient.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }));
      if (value === 0n) throw new Error(`${account.address} holds nothing to recycle`);
      const scope = await this.getScope();
      let state = store.load();
      const index = state.depositCounts[scope.toString()] ?? 0;
      const secrets = depositSecrets(this.keys, scope, BigInt(index));
      // Reserve first: a crash after sending must never reuse these secrets, and sync() recovers the note.
      state.depositCounts[scope.toString()] = index + 1;
      store.save(state);

      const hash = await recycleFrom(account, {
        publicClient,
        asset,
        domain: opts.domain ?? USDG_DOMAIN,
        submitter,
        value,
        precommitment: precommitmentHash(secrets),
        now: this.now(),
      });
      const receipt = await publicClient.getTransactionReceipt({ hash });
      const [event] = parseEventLogs({ abi: [depositedEvent], logs: receipt.logs }).filter((l) => l.address.toLowerCase() === pool.toLowerCase());
      if (!event) throw new Error(`recycle ${hash} made no deposit in the pool`);
      const { _label: label, _value: deposited, _commitment: commitment } = event.args;
      if (commitmentHash(deposited, label, secrets) !== commitment) throw new Error('recycled deposit does not match locally derived secrets');
      const note: PoolNote = { scope: scope.toString(), depositIndex: index, label: label.toString(), value: deposited.toString(), spendCount: 0, depositTx: hash };
      state = store.load();
      state.notes.push(note);
      store.save(state);
      return note;
    });
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
        if (note.ragequitTx) break;
        const label = BigInt(note.label);
        const existing = this.noteSecrets(note);
        const spent = await publicClient.readContract({ address: pool, abi: poolAbi, functionName: 'nullifierHashes', args: [nullifierHash(existing.nullifier)] });
        if (!spent) break;
        const w = await findWithdrawal(publicClient, pool, entrypoint, poolDeploymentBlock, nullifierHash(existing.nullifier), 10_000n, this.config.yieldPool?.funder);
        if (!w) {
          // Not withdrawn: ragequit, then. Nothing is left of the deposit.
          const r = await findRagequit(publicClient, pool, poolDeploymentBlock, commitmentHash(BigInt(note.value), label, existing));
          if (!r) throw new Error(`deposit ${note.label} was spent but neither a withdrawal nor a ragequit was found; check the RPC`);
          note.value = '0';
          note.ragequitTx = r.txHash;
          found.push({ label: note.label, spendIndex: note.spendCount, received: r.value, txHash: r.txHash });
          break;
        }
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

  /**
   * A ragequit proof for what's left of the deposit with `label`: the public exit back to the address
   * that deposited, with no relayer and no approval needed. Submit it to the pool from the original
   * depositor, or to the forwarder (recycler or yield router) the deposit was made through.
   */
  ragequitProof(label: string, prover: RagequitProver): Promise<RagequitSolidityProof> {
    return this.exclusive(async () => {
      const state = this.config.store.load();
      const recovered = await this.recoverDeposits(state);
      if ((await this.syncNotes(state)).length || recovered) this.config.store.save(state);
      const note = state.notes.find((n) => n.label === label);
      if (!note) throw new Error(`no deposit with label ${label}`);
      if (BigInt(note.value) === 0n) throw new Error(`deposit ${label} has nothing left`);
      const { proof } = await prover.prove({ value: BigInt(note.value), label: BigInt(note.label), secrets: this.noteSecrets(note) });
      return proof;
    });
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

  /**
   * Withdraws `value` with a withdrawal processed by a contract of your own instead of the Entrypoint's
   * relay: the proof commits to `processooor` and `data`, and `submit` must get `processooor` to call
   * the pool's `withdraw` (for example the yield pool's SessionFunder, called by a relayer). Returns
   * the transaction once the chain shows the withdrawal.
   */
  withdrawVia(value: bigint, processooor: Address, data: Hex, submit: (withdrawal: Withdrawal, proof: SolidityProof) => Promise<Hex>): Promise<Hex> {
    return this.exclusive(async () => {
      const r = await this.withdrawLocked(value, undefined, { processooor, data, submit });
      if (!('custom' in r)) throw new Error('unreachable');
      return r.custom;
    });
  }

  private async withdrawLocked(
    budget: bigint,
    recipient?: Address,
    custom?: { processooor: Address; data: Hex; submit: (withdrawal: Withdrawal, proof: SolidityProof) => Promise<Hex> },
  ): Promise<{ session: Session } | { funding: Funding } | { custom: Hex }> {
    const { publicClient, entrypoint, pool, relayer, prover, store } = this.config;
    if (budget <= 0n) throw new Error('budget must be positive');

    let state = store.load();
    const recovered = await this.recoverDeposits(state);
    if ((await this.syncNotes(state)).length || recovered) store.save(state);

    // Yield pool: `budget` is the USDG the session gets. Withdraw enough shares for it plus the fees,
    // with a small margin for the share price moving before the proof lands; the funder pays exactly
    // `budget` and the margin left over goes to depositors.
    const yp = custom ? undefined : this.config.yieldPool;
    let withdrawn = budget;
    if (yp) {
      const need = await publicClient.readContract({ address: yp.funder, abi: funderAbi, functionName: 'needed', args: [budget, relayer.relayFeeBPS] });
      const withMargin = need + (need * PoolWallet.YIELD_MARGIN_BPS + 9_999n) / 10_000n;
      withdrawn = await publicClient.readContract({ address: yp.vault, abi: vaultAbi, functionName: 'previewWithdraw', args: [withMargin] });
    }

    const approved = await this.config.associationSet();
    const approvedSet = new Set(approved.map(String));
    const note = state.notes.find((n) => BigInt(n.value) >= withdrawn && approvedSet.has(n.label));
    if (!note) {
      const any = state.notes.some((n) => BigInt(n.value) >= withdrawn);
      throw new Error(any ? 'no approved pool deposit yet; wait for the approval service' : `no pool deposit with at least ${withdrawn} available; deposit more`);
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
    const withdrawal: Withdrawal = custom
      ? { processooor: custom.processooor, data: custom.data }
      : yp
        ? {
            processooor: yp.funder,
            // SodiSessionFunder.FundingData: session, relayer fee recipient, relayer fee, exact amount
            data: encodeAbiParameters(
              [{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }] }],
              [[target, relayer.feeRecipient, relayer.relayFeeBPS, budget]],
            ),
          }
        : {
          processooor: entrypoint,
          data: encodeAbiParameters(
            [{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] }],
            [[target, relayer.feeRecipient, relayer.relayFeeBPS]],
          ),
        };

    const { proof } = await prover.prove({
      withdrawnValue: withdrawn,
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
      let hash: Hex;
      if (custom) hash = await custom.submit(withdrawal, proof);
      else if (yp) {
        if (!relayer.fund) throw new Error('this relayer cannot fund yield-pool sessions');
        hash = await relayer.fund(withdrawal, proof);
      } else hash = await relayer.relay(withdrawal, proof, scope);
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
    if (custom) return { custom: landed.txHash };
    if (landed.recipient?.toLowerCase() !== target.toLowerCase()) {
      throw new Error(`withdrawal ${landed.txHash} paid ${landed.recipient}, not ${target}`);
    }
    if (recipient) return { funding: { address: recipient, received: landed.received, fundingTx: landed.txHash } };

    const session = state.sessions.find((s) => s.address === target);
    if (!session) throw new Error('session withdrawal landed but was not recorded');
    return { session };
  }
}
