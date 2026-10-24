import {
  type ControlSource,
  type Funding,
  type Grant,
  type IssuerError,
  type IssuerFunding,
  type IssuerRefusal,
  type IssuerStatus,
  type SignedIssuerRequest,
  type Store,
  issuerMessage,
  parseIssuerRequest,
} from '@sodi/rx402';
import { type Address, getAddress, recoverMessageAddress } from 'viem';

/** What the issuer needs from the pool: `PoolWallet` provides it. */
export interface PoolFunder {
  fund(budget: bigint, recipient: Address): Promise<Funding>;
  poolBalance(): bigint;
  /** For recycling: a new deposit's precommitment. */
  reservePrecommitment(): Promise<bigint>;
  /** Reserved deposits not found on-chain yet. */
  pendingReservations(): Promise<number>;
  sync(): Promise<void>;
}

export interface IssuerConfig {
  pool: PoolFunder;
  /** Keeps the grants. Can be the pool wallet's own store. */
  store: Store;
  chainId: number;
  /** Agent addresses allowed to ask for sessions. */
  agents: Address[];
  /** Owner controls: `paused` stops all funding; `dailyLimit` caps session funding per rolling 24h. */
  controls: ControlSource;
  /** Largest single session. */
  maxSessionBudget: bigint;
  /** Cap on session funding per rolling 24 hours, on top of any in the controls file. */
  dailyLimit?: bigint;
  /** Reserved deposits for recycling that may be outstanding at once (default 8). */
  maxPendingReservations?: number;
  /** How far a request's timestamp may be from the issuer's clock, in seconds. */
  maxClockSkewSeconds?: number;
  now?: () => number;
  log?: (m: string) => void;
}

export interface IssuerReply {
  status: number;
  body: IssuerFunding | IssuerStatus | IssuerError | { precommitment: string };
}

class Refused extends Error {
  constructor(
    readonly status: number,
    readonly reason: IssuerRefusal,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Funds agent sessions on request, within the owner's limits. This is where the limits are enforced
 * for real: the agent's own caps run on the agent's machine, so they only bind an agent that hasn't
 * been tampered with. Whatever happens on that machine, it can't get more out of the pool than this
 * allows.
 */
export class SessionIssuer {
  private readonly agents: Set<string>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: IssuerConfig) {
    if (config.agents.length === 0) throw new Error('at least one agent address is required');
    if (config.maxSessionBudget <= 0n) throw new Error('maxSessionBudget must be positive');
    this.agents = new Set(config.agents.map((a) => getAddress(a)));
  }

  private now(): number {
    return this.config.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private log(m: string) {
    this.config.log?.(m);
  }

  /** The tighter of the configured limit and the one in the controls file, if any. */
  private dailyLimit(): bigint | undefined {
    const fromControls = this.config.controls.load().dailyLimit;
    const limits = [this.config.dailyLimit, fromControls === undefined ? undefined : BigInt(fromControls)].filter((l): l is bigint => l !== undefined);
    return limits.length ? limits.reduce((a, b) => (a < b ? a : b)) : undefined;
  }

  /** Everything granted in the last 24 hours. Pending and failed grants count: they may still land. */
  fundedSince(since: number): bigint {
    return (this.config.store.load().grants ?? []).filter((g) => g.at >= since).reduce((sum, g) => sum + BigInt(g.budget), 0n);
  }

  /** Handles one request body for `/sessions` or `/status`. */
  async handle(path: string, body: unknown): Promise<IssuerReply> {
    try {
      let signed: SignedIssuerRequest;
      try {
        signed = parseIssuerRequest(body);
      } catch (err) {
        throw new Refused(400, 'bad-request', (err as Error).message);
      }
      const agent = await this.authenticate(signed);
      const { request } = signed;
      if (path === '/status' && request.type === 'status') return { status: 200, body: this.status() };
      if (path === '/precommitment' && request.type === 'reserve-deposit') {
        const run = this.queue.then(() => this.reserve(agent));
        this.queue = run.catch(() => {});
        return { status: 200, body: await run };
      }
      if (path === '/sessions' && request.type === 'open-session') {
        // One funding at a time, so two requests can't both fit under the limit and then exceed it together.
        const run = this.queue.then(() => this.open(agent, request.address, BigInt(request.budget)));
        this.queue = run.catch(() => {});
        return { status: 200, body: await run };
      }
      throw new Refused(400, 'bad-request', `request type ${request.type} is not accepted at ${path}`);
    } catch (err) {
      if (err instanceof Refused) {
        this.log(`refused (${err.reason}): ${err.message}`);
        return { status: err.status, body: { error: err.message, reason: err.reason } };
      }
      this.log(`error: ${(err as Error).message}`);
      return { status: 502, body: { error: `funding failed: ${(err as Error).message.split('\n')[0]}`, reason: 'unavailable' } };
    }
  }

  private async authenticate({ request, signature }: SignedIssuerRequest): Promise<Address> {
    let signer: Address;
    try {
      signer = await recoverMessageAddress({ message: issuerMessage(request), signature });
    } catch {
      throw new Refused(401, 'unauthorized', 'bad signature');
    }
    if (!this.agents.has(signer)) throw new Refused(403, 'unauthorized', `${signer} is not an allowed agent`);
    if (request.chainId !== this.config.chainId) throw new Refused(400, 'bad-request', `wrong chain ${request.chainId}`);
    const skew = this.config.maxClockSkewSeconds ?? 120;
    if (Math.abs(this.now() - request.issuedAt) > skew) throw new Refused(400, 'bad-request', 'request is too old or from the future; check the clocks');
    return signer;
  }

  status(): IssuerStatus {
    const limit = this.dailyLimit();
    return {
      paused: this.config.controls.load().paused,
      maxSessionBudget: this.config.maxSessionBudget.toString(),
      ...(limit === undefined ? {} : { dailyLimit: limit.toString() }),
      fundedLast24h: this.fundedSince(this.now() - 86_400).toString(),
      poolBalance: this.config.pool.poolBalance().toString(),
    };
  }

  /**
   * Gives an agent a precommitment for a new deposit of the owner's, so it can recycle a finished
   * session back into the pool. Recycling only adds to the pool, so it's allowed even when funding is
   * paused, but outstanding reservations are capped: each one is scanned for on every sync.
   */
  private async reserve(agent: Address): Promise<{ precommitment: string }> {
    const { pool } = this.config;
    const cap = this.config.maxPendingReservations ?? 8;
    if ((await pool.pendingReservations()) >= cap) {
      await pool.sync();
      if ((await pool.pendingReservations()) >= cap) throw new Refused(429, 'bad-request', `${cap} reserved deposits haven't landed yet; recycle those first`);
    }
    const precommitment = await pool.reservePrecommitment();
    this.log(`reserved a deposit for ${agent} to recycle into`);
    return { precommitment: precommitment.toString() };
  }

  private async open(agent: Address, rawAddress: Address, budget: bigint): Promise<IssuerFunding> {
    const { store, pool } = this.config;
    const address = getAddress(rawAddress);
    if (this.config.controls.load().paused) throw new Refused(403, 'paused', 'session funding is paused by the owner');
    if (budget > this.config.maxSessionBudget) {
      throw new Refused(403, 'over-session-budget', `budget ${budget} is above the per-session maximum of ${this.config.maxSessionBudget}`);
    }
    const limit = this.dailyLimit();
    if (limit !== undefined) {
      const funded = this.fundedSince(this.now() - 86_400);
      if (funded + budget > limit) throw new Refused(403, 'over-daily-limit', `funding ${budget} would pass the 24-hour limit of ${limit} (${funded} already granted)`);
    }
    // Each address is funded once: a replayed request can't fund it again.
    let state = store.load();
    if ((state.grants ?? []).some((g) => g.address === address)) throw new Refused(409, 'bad-request', `${address} was already funded`);

    // Record the grant before withdrawing: from here on it may land, so it counts against the limit.
    const grant: Grant = { agent, address, budget: budget.toString(), at: this.now(), status: 'pending' };
    (state.grants ??= []).push(grant);
    store.save(state);
    this.log(`funding ${budget} for ${agent} at ${address}`);

    const update = (patch: Partial<Grant>) => {
      state = store.load();
      const g = state.grants?.find((x) => x.address === address);
      if (g) Object.assign(g, patch);
      store.save(state);
    };
    let funding: Funding;
    try {
      funding = await pool.fund(budget, address);
    } catch (err) {
      update({ status: 'failed', error: (err as Error).message.split('\n')[0] });
      throw err;
    }
    update({ status: 'funded', received: funding.received.toString(), fundingTx: funding.fundingTx });
    this.log(`funded ${address} with ${funding.received} in ${funding.fundingTx}`);
    return { address, received: funding.received.toString(), fundingTx: funding.fundingTx };
  }
}
