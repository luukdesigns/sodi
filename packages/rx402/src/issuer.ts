import { type Address, type Hex, type PublicClient, getAddress, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { erc20Abi } from './chain.js';
import { type BlockReason, PaymentBlockedError } from './controls.js';
import { agentSessionPrivateKey } from './crypto.js';
import type { Session, Store } from './store.js';

/**
 * The session issuer protocol.
 *
 * The issuer holds the pool mnemonic and the owner's hard limits; the agent holds only an agent key.
 * To get a new session, the agent derives the next session address from its own key and asks the
 * issuer, with a signed request, to fund it. The issuer checks the signature, its kill switch and its
 * limits, then funds the address with a zero-knowledge withdrawal. No secret ever crosses the wire:
 * requests and responses carry only public data.
 */
export type IssuerRequest =
  | { type: 'open-session'; chainId: number; address: Address; budget: string; issuedAt: number }
  | { type: 'status'; chainId: number; issuedAt: number };

export interface SignedIssuerRequest {
  request: IssuerRequest;
  signature: Hex;
}

export interface IssuerFunding {
  address: Address;
  /** What the session address received, after the relayer's fee. */
  received: string;
  fundingTx: Hex;
}

export interface IssuerStatus {
  paused: boolean;
  maxSessionBudget: string;
  dailyLimit?: string;
  /** Session funding granted in the last 24 hours, including requests that may still land. */
  fundedLast24h: string;
  poolBalance: string;
}

export type IssuerRefusal = BlockReason | 'over-session-budget' | 'unauthorized' | 'bad-request' | 'unavailable';

export interface IssuerError {
  error: string;
  reason?: IssuerRefusal;
}

/** The exact text an agent signs (EIP-191) for a request. */
export function issuerMessage(request: IssuerRequest): string {
  const sorted = Object.fromEntries(Object.entries(request).sort(([a], [b]) => (a < b ? -1 : 1)));
  return `Sodi session issuer request\n${JSON.stringify(sorted)}`;
}

/** Validates the shape of an incoming request; throws with a message the issuer can return. */
export function parseIssuerRequest(body: unknown): SignedIssuerRequest {
  const b = body as Partial<SignedIssuerRequest> | null;
  const r = b?.request as Record<string, unknown> | undefined;
  if (!r || typeof b?.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(b.signature)) throw new Error('expected { request, signature }');
  if (!Number.isSafeInteger(r.chainId) || !Number.isSafeInteger(r.issuedAt)) throw new Error('chainId and issuedAt must be integers');
  if (r.type === 'status') {
    if (Object.keys(r).length !== 3) throw new Error('unexpected fields');
    return { request: { type: 'status', chainId: r.chainId as number, issuedAt: r.issuedAt as number }, signature: b.signature as Hex };
  }
  if (r.type === 'open-session') {
    if (Object.keys(r).length !== 5) throw new Error('unexpected fields');
    if (typeof r.address !== 'string' || !isAddress(r.address, { strict: false })) throw new Error('address is not an address');
    if (typeof r.budget !== 'string' || !/^[1-9][0-9]{0,30}$/.test(r.budget)) throw new Error('budget must be a positive integer string');
    return {
      request: { type: 'open-session', chainId: r.chainId as number, address: r.address as Address, budget: r.budget, issuedAt: r.issuedAt as number },
      signature: b.signature as Hex,
    };
  }
  throw new Error('unknown request type');
}

export interface IssuerSessionsConfig {
  /** Base URL of the session issuer. */
  url: string;
  /** The agent's own key: signs requests and derives session keys. It can't withdraw from the pool. */
  agentKey: Hex;
  publicClient: PublicClient;
  asset: Address;
  /** The agent's store; sessions and their payments are kept here. */
  store: Store;
  now?: () => number;
  /** How long to wait for the issuer, which proves and relays a withdrawal before answering. */
  timeoutMs?: number;
}

/**
 * Gets sessions from a session issuer. Pass it to `Rx402Client` as `sessions`, instead of a mnemonic,
 * so the machine the agent runs on can spend at most what the issuer agrees to fund.
 */
export class IssuerSessions {
  private readonly account;
  private chainId?: number;

  constructor(private readonly config: IssuerSessionsConfig) {
    this.account = privateKeyToAccount(config.agentKey);
  }

  /** The address the issuer must list as an allowed agent. */
  get agentAddress(): Address {
    return this.account.address;
  }

  private now(): number {
    return this.config.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private sessionKey(index: number): Hex {
    return agentSessionPrivateKey(this.config.agentKey, BigInt(index));
  }

  private balanceOf(address: Address): Promise<bigint> {
    return this.config.publicClient.readContract({ address: this.config.asset, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
  }

  private async send<T>(path: string, request: IssuerRequest): Promise<T> {
    const signature = await this.account.signMessage({ message: issuerMessage(request) });
    const res = await fetch(new URL(path, this.config.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request, signature }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 300_000),
    });
    const body = (await res.json().catch(() => ({}))) as T & IssuerError;
    if (!res.ok) {
      const reason = body.reason;
      if (reason === 'paused' || reason === 'over-daily-limit') throw new PaymentBlockedError(reason, `session issuer: ${body.error}`);
      throw Object.assign(new Error(`session issuer refused (${res.status}): ${body.error ?? 'no reason given'}`), { reason });
    }
    return body;
  }

  private async getChainId(): Promise<number> {
    this.chainId ??= await this.config.publicClient.getChainId();
    return this.chainId;
  }

  /** The issuer's kill switch, limits and what's left in the pool. */
  async status(): Promise<IssuerStatus> {
    return this.send<IssuerStatus>('/status', { type: 'status', chainId: await this.getChainId(), issuedAt: this.now() });
  }

  /**
   * Adopts sessions the issuer funded but the agent never saved (it crashed while waiting), so their
   * funds are used rather than stranded. Returns one that can cover `budget`, if any.
   */
  private async adoptFunded(budget: bigint): Promise<Session | undefined> {
    const { store } = this.config;
    const state = store.load();
    let usable: Session | undefined;
    for (let i = 0; i < (state.agentSessionCount ?? 0); i++) {
      const privateKey = this.sessionKey(i);
      const address = privateKeyToAccount(privateKey).address;
      if (state.sessions.some((s) => s.address === address)) continue;
      const balance = await this.balanceOf(address);
      if (balance === 0n) continue;
      const session: Session = { address, privateKey, budget: balance.toString(), spent: '0', payments: 0, openedAt: this.now(), fundingTx: '0x' };
      state.sessions.unshift(session);
      if (balance >= budget) usable = session;
    }
    store.save(state);
    return usable;
  }

  /** Asks the issuer to fund a new session address of the agent's with `budget`. */
  async open(budget: bigint): Promise<Session> {
    const { store } = this.config;
    const adopted = await this.adoptFunded(budget);
    if (adopted) return adopted;

    // Reserve the index before asking, so a crash can never fund one address twice or lose track of it.
    const state = store.load();
    const index = state.agentSessionCount ?? 0;
    state.agentSessionCount = index + 1;
    store.save(state);

    const privateKey = this.sessionKey(index);
    const address = privateKeyToAccount(privateKey).address;
    const funding = await this.send<IssuerFunding>('/sessions', {
      type: 'open-session',
      chainId: await this.getChainId(),
      address,
      budget: budget.toString(),
      issuedAt: this.now(),
    });
    if (getAddress(funding.address) !== address) throw new Error(`session issuer funded ${funding.address}, not ${address}`);
    const received = BigInt(funding.received);
    // Trust the chain, not the issuer's report.
    let balance = 0n;
    for (let attempt = 0; attempt < 10 && balance < received; attempt++) {
      balance = await this.balanceOf(address);
      if (balance < received) await new Promise((r) => setTimeout(r, 1000));
    }
    if (balance < received || received === 0n) throw new Error(`session ${address} holds ${balance}, but the issuer reported funding ${received}`);

    const session: Session = { address, privateKey, budget: received.toString(), spent: '0', payments: 0, openedAt: this.now(), fundingTx: funding.fundingTx };
    const after = store.load();
    after.sessions.push(session);
    store.save(after);
    return session;
  }
}
