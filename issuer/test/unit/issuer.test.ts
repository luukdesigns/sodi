/**
 * The session issuer against a real agent client over HTTP, with the pool and chain faked: who may
 * ask, the kill switch, per-session and 24-hour limits that hold whatever the agent does, replays,
 * and an agent that crashes while waiting.
 */
import type { AddressInfo } from 'node:net';

import {
  IssuerSessions,
  MemoryControls,
  MemoryStore,
  PaymentBlockedError,
  Rx402Client,
  agentSessionPrivateKey,
  issuerMessage,
} from '@sodi/rx402';
import type { Address, Hex, PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionIssuer } from '../../src/issuer.js';
import { startServer } from '../../src/server.js';

const ASSET = '0x00000000000000000000000000000000000000a5' as Address;
const CHAIN = 46630;

async function setup(opts: { maxSessionBudget?: bigint; dailyLimit?: bigint; fee?: bigint; fail?: boolean; lie?: boolean } = {}) {
  const balances = new Map<string, bigint>();
  const funded: { budget: bigint; to: Address }[] = [];
  let pool = 10_000_000n;
  let tx = 0;
  const fake = {
    async fund(budget: bigint, to: Address) {
      funded.push({ budget, to });
      if (opts.fail) throw new Error('relayer down');
      const received = budget - (opts.fee ?? 0n);
      pool -= budget;
      if (!opts.lie) balances.set(to.toLowerCase(), (balances.get(to.toLowerCase()) ?? 0n) + received);
      return { address: to, received, fundingTx: `0x${(++tx).toString(16).padStart(64, '0')}` as Hex };
    },
    poolBalance: () => pool,
  };
  const publicClient = {
    getChainId: async () => CHAIN,
    readContract: async ({ functionName, args }: { functionName: string; args: [Address] }) => {
      if (functionName !== 'balanceOf') throw new Error(functionName);
      return balances.get(args[0].toLowerCase()) ?? 0n;
    },
  } as unknown as PublicClient;

  const agentKey = generatePrivateKey();
  const agent = privateKeyToAccount(agentKey);
  const controls = new MemoryControls();
  const issuerStore = new MemoryStore();
  const issuer = new SessionIssuer({
    pool: fake,
    store: issuerStore,
    chainId: CHAIN,
    agents: [agent.address],
    controls,
    maxSessionBudget: opts.maxSessionBudget ?? 1_000_000n,
    dailyLimit: opts.dailyLimit,
  });
  const server = startServer(issuer, 0);
  servers.push(server);
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const agentStore = new MemoryStore();
  const sessions = () => new IssuerSessions({ url: url(), agentKey, publicClient, asset: ASSET, store: agentStore });
  const post = (path: string, body: unknown) =>
    fetch(`${url()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { fake, funded, balances, publicClient, agentKey, agent, controls, issuer, issuerStore, agentStore, sessions, url, post };
}

const servers: ReturnType<typeof startServer>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const now = () => Math.floor(Date.now() / 1000);

describe('session issuer', () => {
  it('funds a session address derived from the agent key, and only that', async () => {
    const t = await setup({ fee: 5_000n });
    const session = await t.sessions().open(500_000n);
    const expected = privateKeyToAccount(agentSessionPrivateKey(t.agentKey, 0n));
    expect(session.address).toBe(expected.address);
    expect(session.privateKey).toBe(agentSessionPrivateKey(t.agentKey, 0n));
    expect(session.budget).toBe('495000');
    expect(t.funded).toEqual([{ budget: 500_000n, to: expected.address }]);
    const grants = t.issuerStore.load().grants!;
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ agent: t.agent.address, address: expected.address, budget: '500000', status: 'funded', received: '495000' });
    // The next session is a different address.
    const second = await t.sessions().open(500_000n);
    expect(second.address).toBe(privateKeyToAccount(agentSessionPrivateKey(t.agentKey, 1n)).address);
  });

  it('refuses agents it does not know and tampered requests', async () => {
    const t = await setup();
    const stranger = generatePrivateKey();
    const other = new IssuerSessions({ url: t.url(), agentKey: stranger, publicClient: t.publicClient, asset: ASSET, store: new MemoryStore() });
    await expect(other.open(100_000n)).rejects.toThrow(/not an allowed agent/);

    // A request signed for 0.1 can't be turned into a request for 1.
    const request = { type: 'open-session' as const, chainId: CHAIN, address: privateKeyToAccount(generatePrivateKey()).address, budget: '100000', issuedAt: now() };
    const signature = await t.agent.signMessage({ message: issuerMessage(request) });
    const res = await t.post('/sessions', { request: { ...request, budget: '1000000' }, signature });
    expect(res.status).toBe(403);
    expect(t.funded).toHaveLength(0);

    const garbage = await t.post('/sessions', { request: { ...request, extra: 1 }, signature });
    expect(garbage.status).toBe(400);
  });

  it('refuses old requests and replays', async () => {
    const t = await setup();
    const address = privateKeyToAccount(generatePrivateKey()).address;
    const stale = { type: 'open-session' as const, chainId: CHAIN, address, budget: '100000', issuedAt: now() - 600 };
    let res = await t.post('/sessions', { request: stale, signature: await t.agent.signMessage({ message: issuerMessage(stale) }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/too old/);

    const fresh = { ...stale, issuedAt: now() };
    const body = { request: fresh, signature: await t.agent.signMessage({ message: issuerMessage(fresh) }) };
    expect((await t.post('/sessions', body)).status).toBe(200);
    res = await t.post('/sessions', body);
    expect(res.status).toBe(409);
    expect(t.funded).toHaveLength(1);
  });

  it('obeys the kill switch, and the agent sees it as a pause', async () => {
    const t = await setup();
    t.controls.save({ paused: true });
    const err = await t.sessions().open(100_000n).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentBlockedError);
    expect(err.reason).toBe('paused');
    expect(t.funded).toHaveLength(0);
    expect((await t.sessions().status()).paused).toBe(true);
  });

  it('caps each session', async () => {
    const t = await setup({ maxSessionBudget: 200_000n });
    await expect(t.sessions().open(200_001n)).rejects.toThrow(/per-session maximum/);
    expect(t.funded).toHaveLength(0);
  });

  it('caps funding per 24 hours, counting failed attempts, whichever limit is tighter', async () => {
    const t = await setup({ dailyLimit: 1_000_000n });
    await t.sessions().open(600_000n);
    const err = await t.sessions().open(600_000n).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentBlockedError);
    expect(err.reason).toBe('over-daily-limit');
    // The controls file can tighten it further.
    t.controls.save({ paused: false, dailyLimit: '700000' });
    await expect(t.sessions().open(200_000n)).rejects.toThrow(/24-hour limit of 700000/);
    await t.sessions().open(100_000n);
    const status = await t.sessions().status();
    expect(status).toMatchObject({ dailyLimit: '700000', fundedLast24h: '700000', maxSessionBudget: '1000000' });

    // A withdrawal that failed may still land later, so it keeps counting.
    const f = await setup({ dailyLimit: 1_000_000n, fail: true });
    await expect(f.sessions().open(600_000n)).rejects.toThrow(/funding failed: relayer down/);
    expect(f.issuerStore.load().grants![0]!.status).toBe('failed');
    await expect(f.sessions().open(600_000n)).rejects.toThrow(/24-hour limit/);
  });

  it("doesn't let parallel requests pass the limit together", async () => {
    const t = await setup({ dailyLimit: 1_000_000n });
    const addrs = Array.from({ length: 4 }, () => privateKeyToAccount(generatePrivateKey()).address);
    const results = await Promise.all(
      addrs.map(async (address) => {
        const request = { type: 'open-session' as const, chainId: CHAIN, address, budget: '400000', issuedAt: now() };
        return (await t.post('/sessions', { request, signature: await t.agent.signMessage({ message: issuerMessage(request) }) })).status;
      }),
    );
    expect(results.filter((s) => s === 200)).toHaveLength(2);
    expect(t.funded).toHaveLength(2);
  });

  it("doesn't believe an issuer that reports funding the chain doesn't show", async () => {
    const t = await setup({ lie: true });
    await expect(t.sessions().open(100_000n)).rejects.toThrow(/holds 0, but the issuer reported/);
  }, 20_000);

  it('adopts a session funded while the agent was down instead of asking again', async () => {
    const t = await setup();
    // The agent reserved index 0 and asked, then crashed before saving the answer.
    t.agentStore.save({ ...t.agentStore.load(), agentSessionCount: 1 });
    const address = privateKeyToAccount(agentSessionPrivateKey(t.agentKey, 0n)).address;
    const request = { type: 'open-session' as const, chainId: CHAIN, address, budget: '300000', issuedAt: now() };
    expect((await t.post('/sessions', { request, signature: await t.agent.signMessage({ message: issuerMessage(request) }) })).status).toBe(200);

    const session = await t.sessions().open(300_000n);
    expect(session.address).toBe(address);
    expect(session.budget).toBe('300000');
    expect(t.funded).toHaveLength(1);
  });

  it('runs an rx402 client that holds no pool secret', async () => {
    const t = await setup();
    const client = new Rx402Client({
      publicClient: t.publicClient,
      asset: ASSET,
      store: t.agentStore,
      sessions: t.sessions(),
      policy: { budget: 250_000n, maxPayments: 5, maxAgeSeconds: 3600, maxPaymentAmount: 50_000n },
    });
    expect(client.holdsPoolSecret).toBe(false);
    expect(client.canDeposit).toBe(false);
    expect(client.poolBalance()).toBeUndefined();
    expect(() => client.deposit(1n)).toThrow(/session issuer/);
    // The client's own caps still apply before anything reaches the issuer.
    await expect(client.openSession(300_000n)).rejects.toThrow(/between 1 and 250000/);
    const s = await client.openSession();
    expect(client.currentSession()?.address).toBe(s.address);
    expect(t.funded).toEqual([{ budget: 250_000n, to: s.address }]);
  });
});
