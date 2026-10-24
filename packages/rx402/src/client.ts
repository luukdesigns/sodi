import { readStealthOffer, stealthRecipient } from '@sodi/stealth';
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeAbiParameters,
  parseEventLogs,
} from 'viem';
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
import { type ControlSource, type Controls, PaymentBlockedError } from './controls.js';
import type { WithdrawalProver } from './prover.js';
import type { Relayer } from './relayer.js';
import type { PaymentRecord, PoolNote, Session, Store, WalletState } from './store.js';
import { paymentHeader, parsePaymentRequired, selectRequirement, signAuthorization } from './x402.js';

export interface SessionPolicy {
  /** Amount withdrawn into each new session (asset base units). */
  budget: bigint;
  /** Rotate to a new address after this many payments. */
  maxPayments: number;
  /** Rotate after this many seconds. */
  maxAgeSeconds: number;
  /** Refuse any single payment above this amount. */
  maxPaymentAmount: bigint;
}

export interface Rx402Config {
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
  policy: SessionPolicy;
  /**
   * Pay merchants that offer a stealth address (the x402 stealth extension) at a fresh one-time
   * address instead of their public `payTo`. On by default; merchants that don't offer one are
   * paid normally either way.
   */
  stealth?: boolean;
  /** Owner controls (kill switch, caps, allowed hosts), re-read before every payment. */
  controls?: ControlSource;
  now?: () => number;
}

export interface PaidResponse {
  response: Response;
  /**
   * Set when a payment was signed for this request. `accepted` is false if the merchant then
   * answered with an error; the payment still counts against limits, since it may be settled.
   */
  payment?: { amount: bigint; payTo: Address; from: Address; stealth: boolean; accepted: boolean };
}

/**
 * rx402: private x402 payments.
 *
 * The owner deposits into a Privacy Pool once. Each *session* is a zero-knowledge withdrawal of a
 * small budget, relayed to a brand-new address that pays x402 merchants with EIP-3009 signatures.
 * Merchants see an ordinary payment from an address with no history; nothing links it to the owner
 * or to the agent's other sessions.
 */
export class Rx402Client {
  private readonly keys: MasterKeys;
  private scope?: bigint;
  private chainId?: number;

  constructor(private readonly config: Rx402Config) {
    this.keys = generateMasterKeys(config.mnemonic);
  }

  private now(): number {
    return this.config.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private async getScope(): Promise<bigint> {
    this.scope ??= await this.config.publicClient.readContract({
      address: this.config.pool,
      abi: poolAbi,
      functionName: 'SCOPE',
    });
    return this.scope;
  }

  private async getChainId(): Promise<number> {
    this.chainId ??= await this.config.publicClient.getChainId();
    return this.chainId;
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

  /** Total value still in the pool across all notes. */
  poolBalance(): bigint {
    return this.config.store.load().notes.reduce((sum, n) => sum + BigInt(n.value), 0n);
  }

  /** The session the next payment would use, with what it has left. */
  currentSession(): (Session & { remaining: bigint; ageSeconds: number }) | undefined {
    const s = this.config.store.load().sessions.at(-1);
    if (!s) return undefined;
    return { ...s, remaining: BigInt(s.budget) - BigInt(s.spent), ageSeconds: this.now() - s.openedAt };
  }

  get policy(): Readonly<SessionPolicy> {
    return this.config.policy;
  }

  /** The owner controls currently in force, if any are configured. */
  get controls(): Controls | undefined {
    return this.config.controls?.load();
  }

  get canDeposit(): boolean {
    return Boolean(this.config.ownerWallet?.account);
  }

  // ---------------------------------------------------------------- sessions

  /**
   * Brings the store in line with the chain. Withdrawals are recorded only once they are confirmed
   * on-chain, and session keys are derived from the mnemonic, so whatever happened before (a relayer
   * that failed after broadcasting, a crash, a relayer that held a proof and landed it later), the
   * notes and sessions can be rebuilt here.
   */
  private async syncNotes(state: WalletState): Promise<boolean> {
    const { publicClient, pool, entrypoint, poolDeploymentBlock } = this.config;
    let changed = false;
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
        if (!state.sessions.some((s) => s.address === address) && w.recipient?.toLowerCase() === address.toLowerCase()) {
          state.sessions.push({
            address,
            privateKey: key,
            budget: (w.received ?? w.value).toString(),
            spent: '0',
            payments: 0,
            openedAt: this.now(),
            fundingTx: w.txHash,
          });
        }
        note.value = remaining.toString();
        note.spendCount += 1;
        changed = true;
      }
    }
    return changed;
  }

  private noteSecrets(note: PoolNote) {
    return note.spendCount === 0
      ? depositSecrets(this.keys, BigInt(note.scope), BigInt(note.depositIndex))
      : withdrawalSecrets(this.keys, BigInt(note.label), BigInt(note.spendCount - 1));
  }

  /**
   * Withdraws `budget` from the pool to a fresh address via the relayer, with a zero-knowledge proof.
   * The withdrawal reveals the amount and the new address, but not which deposit it came from.
   */
  openSession(budget: bigint = this.config.policy.budget): Promise<Session> {
    return this.exclusive(() => this.openSessionLocked(budget));
  }

  private async openSessionLocked(budget: bigint): Promise<Session> {
    const { publicClient, entrypoint, pool, relayer, prover, store, policy } = this.config;
    if (this.config.controls?.load().paused) throw new PaymentBlockedError('paused', 'payments are paused by the owner');
    const largest = policy.budget > policy.maxPaymentAmount ? policy.budget : policy.maxPaymentAmount;
    if (budget <= 0n || budget > largest) throw new Error(`session budget must be between 1 and ${largest}`);

    let state = store.load();
    const recovered = await this.recoverDeposits(state);
    if ((await this.syncNotes(state)) || recovered) store.save(state);

    const approved = await this.config.associationSet();
    const approvedSet = new Set(approved.map(String));
    const note = state.notes.find((n) => BigInt(n.value) >= budget && approvedSet.has(n.label));
    if (!note) {
      const any = state.notes.some((n) => BigInt(n.value) >= budget);
      throw new Error(any ? 'no approved pool deposit yet; wait for the approval service' : `no pool deposit with at least ${budget} available; deposit more`);
    }

    const scope = await this.getScope();
    const label = BigInt(note.label);
    const existingValue = BigInt(note.value);
    const existing = this.noteSecrets(note);
    const next = withdrawalSecrets(this.keys, label, BigInt(note.spendCount));

    // Inclusion proofs: the note is in the pool's state tree, and its label is approved.
    const leaves = await stateTreeLeaves(publicClient, pool, this.config.poolDeploymentBlock);
    const stateProof = merkleProof(leaves, commitmentHash(existingValue, label, existing));
    const aspProof = merkleProof(approved, label);
    const onChainAsp = await latestAspRoot(publicClient, entrypoint);
    if (aspProof.root !== onChainAsp) {
      throw new Error('association set does not match the on-chain root; is the approval service in sync?');
    }

    const sessionAddress = privateKeyToAccount(sessionPrivateKey(this.keys, label, BigInt(note.spendCount))).address;
    const withdrawal = {
      processooor: entrypoint,
      data: encodeAbiParameters(
        [{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] }],
        [[sessionAddress, relayer.feeRecipient, relayer.relayFeeBPS]],
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
    await this.syncNotes(state);
    store.save(state);
    const session = state.sessions.find((s) => s.address === sessionAddress);
    if (!session) {
      throw new Error(
        `the session withdrawal did not land${relayError ? `: ${(relayError as Error).message}` : ' (the relayer reported a transaction the chain does not show)'}`,
      );
    }
    // Make the new session current even if older ones were recovered during the sync.
    state.sessions = [...state.sessions.filter((s) => s !== session), session];
    store.save(state);
    return session;
  }

  /** The current session if it can still pay `amount` under the rotation policy. */
  private usableSession(state: WalletState, amount: bigint): Session | undefined {
    const s = state.sessions.at(-1);
    if (!s) return undefined;
    const { maxPayments, maxAgeSeconds } = this.config.policy;
    const remaining = BigInt(s.budget) - BigInt(s.spent);
    if (remaining < amount || s.payments >= maxPayments || this.now() - s.openedAt >= maxAgeSeconds) {
      return undefined;
    }
    return s;
  }

  /** Total handed to merchants since `sinceSeconds`, counting payments a merchant didn't confirm. */
  spentSince(sinceSeconds: number): bigint {
    return (this.config.store.load().payments ?? []).filter((p) => p.at >= sinceSeconds).reduce((sum, p) => sum + BigInt(p.amount), 0n);
  }

  // ---------------------------------------------------------------- x402

  private queue: Promise<unknown> = Promise.resolve();

  /** Runs one payment-affecting operation at a time, so limits and the store can't race. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * `fetch` that pays x402 `402 Payment Required` responses from a private session, opening or
   * rotating sessions as needed.
   *
   * A payment counts against every limit as soon as it is signed, whether or not the merchant then
   * answers successfully, because a signed authorization can be settled either way.
   */
  async fetch(
    input: string | URL,
    init: RequestInit = {},
    options: { maxPaymentAmount?: bigint; allowedHosts?: string[] } = {},
  ): Promise<PaidResponse> {
    const first = await fetch(input, init);
    if (first.status !== 402) return { response: first };
    // Pay the server that actually asked for payment, after any redirects, and check that one.
    const url = new URL(first.url || String(input));
    const required = await parsePaymentRequired(first);
    return this.exclusive(() => this.pay(url, init, options, required));
  }

  private async pay(
    url: URL,
    init: RequestInit,
    options: { maxPaymentAmount?: bigint; allowedHosts?: string[] },
    required: Awaited<ReturnType<typeof parsePaymentRequired>>,
  ): Promise<PaidResponse> {
    const chainId = await this.getChainId();
    const controls = this.config.controls?.load();
    if (controls?.paused) throw new PaymentBlockedError('paused', 'payments are paused by the owner');
    const hostAllowed = (list?: string[]) => !list?.length || list.some((h) => h.toLowerCase() === url.host || h.toLowerCase() === url.hostname);
    if (!hostAllowed(controls?.allowedHosts) || !hostAllowed(options.allowedHosts)) {
      throw new PaymentBlockedError('host-not-allowed', `${url.host} is not on the allowed list`);
    }
    // Per-call caps and owner controls can only tighten the policy, never loosen it.
    let cap = this.config.policy.maxPaymentAmount;
    for (const c of [options.maxPaymentAmount, controls?.maxPaymentAmount === undefined ? undefined : BigInt(controls.maxPaymentAmount)]) {
      if (c !== undefined && c < cap) cap = c;
    }
    let requirement = selectRequirement(required, chainId, this.config.asset, this.config.policy.maxPaymentAmount);
    if (requirement.amount > cap) {
      try {
        requirement = selectRequirement(required, chainId, this.config.asset, cap);
      } catch {
        throw new PaymentBlockedError('over-request-cap', `price ${requirement.amount} is above the cap of ${cap}`);
      }
    }
    if (controls?.dailyLimit !== undefined) {
      const spent = this.spentSince(this.now() - 86_400);
      if (spent + requirement.amount > BigInt(controls.dailyLimit)) {
        throw new PaymentBlockedError('over-daily-limit', `paying ${requirement.amount} would pass the 24-hour limit (${spent} already spent)`);
      }
    }

    let state = this.config.store.load();
    let session = this.usableSession(state, requirement.amount);
    if (!session) {
      const budget = this.config.policy.budget > requirement.amount ? this.config.policy.budget : requirement.amount;
      session = await this.openSessionLocked(budget);
      state = this.config.store.load();
    }

    const account = privateKeyToAccount(session.privateKey);
    const offer = this.config.stealth === false ? undefined : readStealthOffer(requirement.extra);
    const stealth = offer ? stealthRecipient(offer) : undefined;
    const signed = await signAuthorization(account, requirement, chainId, this.now(), stealth?.to);
    const [name, value] = paymentHeader(required.version, requirement, signed, stealth?.proof);

    // Record the payment before handing the signature over: from here on it can be settled.
    const s = state.sessions.find((x) => x.address === session!.address)!;
    s.spent = (BigInt(s.spent) + requirement.amount).toString();
    s.payments += 1;
    const record: PaymentRecord = {
      id: signed.authorization.nonce,
      at: this.now(),
      resource: `${url.origin}${url.pathname}`,
      amount: requirement.amount.toString(),
      payTo: signed.authorization.to,
      stealth: Boolean(stealth),
      session: account.address,
      status: 'pending',
    };
    (state.payments ??= []).push(record);
    this.config.store.save(state);

    const headers = new Headers(init.headers);
    headers.set(name, value);
    const payment = { amount: requirement.amount, payTo: signed.authorization.to, from: account.address, stealth: Boolean(stealth) };
    let response: Response;
    try {
      // No redirects once a signed payment is attached: it must only ever go to the server that asked.
      response = await fetch(url, { ...init, headers, redirect: 'error' });
    } catch (err) {
      this.setStatus(record, 'refused');
      throw Object.assign(new Error(`payment request failed after signing: ${(err as Error).message}`), { payment });
    }
    this.setStatus(record, response.ok ? 'accepted' : 'refused');
    return { response, payment: { ...payment, accepted: response.ok } };
  }

  private setStatus(record: PaymentRecord, status: NonNullable<PaymentRecord['status']>) {
    const state = this.config.store.load();
    const r = state.payments?.find((p) => p.id === record.id);
    if (r) {
      r.status = status;
      this.config.store.save(state);
    }
  }
}

export type { Hex };
