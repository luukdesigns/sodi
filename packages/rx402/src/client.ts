import { readStealthOffer, stealthRecipient } from '@sodi/stealth';
import type { Address, Hex, PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { type ControlSource, type Controls, PaymentBlockedError } from './controls.js';
import type { PaymentRecord, PoolNote, Session, Store, WalletState } from './store.js';
import { erc20Abi } from './chain.js';
import { type RecycleSubmitter, type TokenDomain, USDG_DOMAIN, recycleFrom, recycleMinimum } from './recycle.js';
import { PoolWallet, type PoolWalletConfig } from './wallet.js';
import { MAX_VALIDITY_SECONDS } from './x402.js';
import { paymentHeader, parsePaymentRequired, selectRequirement, signAuthorization } from './x402.js';

/** Where new sessions come from: the pool wallet in-process, or a session issuer. */
export interface SessionSource {
  open(budget: bigint): Promise<Session>;
  /** Reserves a deposit in the owner's pool for recycling a session, and returns its precommitment. */
  reservePrecommitment?(): Promise<bigint>;
}

export interface RecycleOutcome {
  session: Address;
  amount: bigint;
  status: 'recycled' | 'empty' | 'too-small' | 'failed';
  tx?: Hex;
  error?: string;
}

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

interface CommonConfig {
  publicClient: PublicClient;
  asset: Address;
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

/** The agent holds the pool mnemonic and funds its own sessions. Whoever controls its machine controls the pool. */
export interface LocalRx402Config extends CommonConfig, PoolWalletConfig {
  sessions?: undefined;
}

/**
 * Sessions come from elsewhere, usually `IssuerSessions`: the agent holds no pool secret, and its
 * machine can spend at most what the issuer agrees to fund.
 */
export interface IssuedRx402Config extends CommonConfig {
  sessions: SessionSource;
}

export type Rx402Config = LocalRx402Config | IssuedRx402Config;

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
  private readonly wallet?: PoolWallet;
  private readonly sessions: SessionSource;
  private chainId?: number;

  constructor(private readonly config: Rx402Config) {
    if (config.sessions) {
      this.sessions = config.sessions;
    } else {
      const wallet = new PoolWallet(config);
      this.wallet = wallet;
      this.sessions = { open: (budget) => wallet.openSession(budget), reservePrecommitment: () => wallet.reservePrecommitment() };
    }
  }

  private now(): number {
    return this.config.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private async getChainId(): Promise<number> {
    this.chainId ??= await this.config.publicClient.getChainId();
    return this.chainId;
  }

  /** True when the pool mnemonic is held in this process rather than by a session issuer. */
  get holdsPoolSecret(): boolean {
    return Boolean(this.wallet);
  }

  // ---------------------------------------------------------------- deposits

  /** Deposits `amount` of the asset from the owner wallet. This step is public. */
  deposit(amount: bigint): Promise<PoolNote> {
    if (!this.wallet) throw new Error('deposits are made by the session issuer, not the agent');
    return this.wallet.deposit(amount);
  }

  /** Total value still in the pool across all notes, if this process holds the pool. */
  poolBalance(): bigint | undefined {
    return this.wallet?.poolBalance();
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
    return Boolean(this.wallet?.canDeposit);
  }

  // ---------------------------------------------------------------- sessions

  /**
   * Opens a new session with `budget`: a zero-knowledge withdrawal from the pool to a brand-new
   * address, made here or by the session issuer. It reveals the amount and the address, not which
   * deposit it came from.
   */
  openSession(budget: bigint = this.config.policy.budget): Promise<Session> {
    return this.exclusive(() => this.openSessionLocked(budget));
  }

  private async openSessionLocked(budget: bigint): Promise<Session> {
    const { store, policy } = this.config;
    if (this.config.controls?.load().paused) throw new PaymentBlockedError('paused', 'payments are paused by the owner');
    const largest = policy.budget > policy.maxPaymentAmount ? policy.budget : policy.maxPaymentAmount;
    if (budget <= 0n || budget > largest) throw new Error(`session budget must be between 1 and ${largest}`);

    const session = await this.sessions.open(budget);
    // Make the new session current, even if older ones were recovered along the way.
    const state = store.load();
    state.sessions = [...state.sessions.filter((s) => s.address !== session.address), session];
    store.save(state);
    return session;
  }

  /**
   * Puts what's left in finished sessions back into the pool, as new deposits of the owner's, through
   * the SodiRecycler. The current session is left alone, and so is any session that signed a payment
   * recently: a merchant may still settle it, so its funds must stay until every authorization it
   * signed has expired.
   *
   * Each recycle is public (this session put this amount into the pool) and is submitted by
   * `submitter`, so use a shared relayer. Sessions holding less than the pool's minimum deposit plus
   * the submitter's fee can't be recycled and are reported as `too-small`.
   */
  recycleSessions(opts: { submitter: RecycleSubmitter; domain?: TokenDomain; idleSeconds?: number }): Promise<RecycleOutcome[]> {
    return this.exclusive(async () => {
      const { publicClient, asset, store } = this.config;
      const reserve = this.sessions.reservePrecommitment?.bind(this.sessions);
      if (!reserve) throw new Error('this session source cannot reserve deposits for recycling');
      const idle = Math.max(opts.idleSeconds ?? 600, MAX_VALIDITY_SECONDS + 60);
      const minimum = (await recycleMinimum(publicClient, opts.submitter.recycler)) + opts.submitter.recycleFee;
      const state = store.load();
      const current = state.sessions.at(-1)?.address;
      const outcomes: RecycleOutcome[] = [];
      for (const s of state.sessions) {
        if (s.address === current || s.recycledTx) continue;
        const lastSigned = Math.max(s.openedAt, ...(state.payments ?? []).filter((p) => p.session === s.address).map((p) => p.at));
        if (this.now() - lastSigned < idle) continue;
        const amount = await publicClient.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [s.address] });
        if (amount === 0n) {
          outcomes.push({ session: s.address, amount, status: 'empty' });
          continue;
        }
        if (amount < minimum) {
          outcomes.push({ session: s.address, amount, status: 'too-small' });
          continue;
        }
        try {
          const account = privateKeyToAccount(s.privateKey);
          let tx: Hex;
          if (this.wallet) {
            tx = (await this.wallet.recycle(account, opts.submitter, { domain: opts.domain, value: amount })).depositTx;
          } else {
            const precommitment = await reserve();
            tx = await recycleFrom(account, { publicClient, asset, domain: opts.domain ?? USDG_DOMAIN, submitter: opts.submitter, value: amount, precommitment, now: this.now() });
          }
          const latest = store.load();
          const rec = latest.sessions.find((x) => x.address === s.address);
          if (rec) rec.recycledTx = tx;
          store.save(latest);
          outcomes.push({ session: s.address, amount, status: 'recycled', tx });
        } catch (err) {
          outcomes.push({ session: s.address, amount, status: 'failed', error: (err as Error).message.split('\n')[0] });
        }
      }
      return outcomes;
    });
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
    const signed = await signAuthorization(account, requirement, chainId, this.now(), stealth?.to, stealth ? { nonce: stealth.nonce, receive: true } : {});
    // Who is being paid: the merchant, or its one-time stealth address (the settler only passes it on).
    const payee = stealth ? stealth.proof.stealthAddress : signed.authorization.to;
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
      payTo: payee,
      stealth: Boolean(stealth),
      session: account.address,
      status: 'pending',
    };
    (state.payments ??= []).push(record);
    this.config.store.save(state);

    const headers = new Headers(init.headers);
    headers.set(name, value);
    const payment = { amount: requirement.amount, payTo: payee, from: account.address, stealth: Boolean(stealth) };
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
