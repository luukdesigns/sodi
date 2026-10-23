import { type Server, createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Address, PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FileControls, MemoryControls, MemoryStore, PaymentBlockedError, Rx402Client } from '../../src/index.js';

const USDG = '0x7E955252E15c84f5768B83c41a71F9eba181802F' as Address;
const MERCHANT = '0x000000000000000000000000000000000000bEEF' as Address;
const PORT = 18611;

// A merchant that charges per path and accepts any signed payment (settlement is not under test).
let server: Server;
const prices: Record<string, bigint> = { '/cheap': 10_000n, '/pricey': 90_000n };
beforeAll(() => {
  server = createServer((req, res) => {
    const amount = prices[(req.url ?? '').split('?')[0]!];
    if (amount === undefined) return void res.writeHead(404).end();
    if (req.headers['x-payment']) return void res.writeHead(200).end('ok');
    res.writeHead(402, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        x402Version: 1,
        accepts: [{ scheme: 'exact', network: 'robinhood-testnet', asset: USDG, payTo: MERCHANT, maxAmountRequired: amount.toString(), maxTimeoutSeconds: 60 }],
      }),
    );
  });
  server.listen(PORT);
});
afterAll(() => server.close());

const url = (p: string) => `http://127.0.0.1:${PORT}${p}`;
let store: MemoryStore;
let controls: MemoryControls;
let now = 1_800_000_000;

function client() {
  return new Rx402Client({
    publicClient: { getChainId: async () => 46630 } as unknown as PublicClient,
    mnemonic: 'test test test test test test test test test test test junk',
    entrypoint: USDG,
    pool: USDG,
    asset: USDG,
    poolDeploymentBlock: 0n,
    relayer: undefined as never,
    prover: undefined as never,
    associationSet: async () => [],
    store,
    controls,
    policy: { budget: 1_000_000n, maxPayments: 100, maxAgeSeconds: 10 ** 9, maxPaymentAmount: 100_000n },
    now: () => now,
  });
}

beforeEach(() => {
  // A funded session already exists, so no pool withdrawal is needed.
  const key = generatePrivateKey();
  store = new MemoryStore();
  store.save({
    version: 1,
    notes: [],
    depositCounts: {},
    sessions: [{ address: privateKeyToAccount(key).address, privateKey: key, budget: '1000000', spent: '0', payments: 0, openedAt: now, fundingTx: '0x00' }],
  });
  controls = new MemoryControls();
});

const blocked = async (p: Promise<unknown>, reason: string) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(PaymentBlockedError);
  expect((err as PaymentBlockedError).reason).toBe(reason);
};

describe('owner controls', () => {
  it('records each payment in the history', async () => {
    const { payment } = await client().fetch(url('/cheap?q=secret'));
    expect(payment?.amount).toBe(10_000n);
    const [rec] = store.load().payments!;
    expect(rec).toMatchObject({ at: now, resource: url('/cheap'), amount: '10000', payTo: MERCHANT, stealth: false });
  });

  it('the kill switch stops payments, and takes effect without a restart', async () => {
    const c = client();
    await c.fetch(url('/cheap'));
    controls.save({ paused: true });
    await blocked(c.fetch(url('/cheap')), 'paused');
    controls.save({ paused: false });
    expect((await c.fetch(url('/cheap'))).response.status).toBe(200);
    expect(store.load().payments).toHaveLength(2);
  });

  it('caps a single payment below the agent policy', async () => {
    controls.save({ paused: false, maxPaymentAmount: '50000' });
    await blocked(client().fetch(url('/pricey')), 'over-request-cap');
    expect((await client().fetch(url('/cheap'))).response.status).toBe(200);
  });

  it('cannot raise the agent policy', async () => {
    controls.save({ paused: false, maxPaymentAmount: '1000000000' });
    prices['/huge'] = 500_000n;
    await expect(client().fetch(url('/huge'))).rejects.toThrow(/no acceptable payment option/);
  });

  it('enforces a rolling 24-hour limit', async () => {
    controls.save({ paused: false, dailyLimit: '25000' });
    const c = client();
    await c.fetch(url('/cheap'));
    await c.fetch(url('/cheap'));
    await blocked(c.fetch(url('/cheap')), 'over-daily-limit');
    now += 86_401;
    expect((await c.fetch(url('/cheap'))).response.status).toBe(200);
  });

  it('only pays allowed hosts when a list is set', async () => {
    controls.save({ paused: false, allowedHosts: ['api.example.com'] });
    await blocked(client().fetch(url('/cheap')), 'host-not-allowed');
    controls.save({ paused: false, allowedHosts: [`127.0.0.1:${PORT}`] });
    expect((await client().fetch(url('/cheap'))).response.status).toBe(200);
  });

  it('does not charge for responses that need no payment', async () => {
    controls.save({ paused: true });
    expect((await client().fetch(url('/missing'))).response.status).toBe(404);
  });
});

describe('controls file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sodi-controls-'));

  it('defaults to running when there is no file', () => {
    expect(new FileControls(join(dir, 'none.json')).load()).toEqual({ paused: false });
  });

  it('round-trips and stamps the update time', () => {
    const f = new FileControls(join(dir, 'c.json'));
    f.save({ paused: true, dailyLimit: '5' });
    expect(f.load()).toMatchObject({ paused: true, dailyLimit: '5' });
    expect(f.load().updatedAt).toBeGreaterThan(0);
  });

  it('fails closed on a file it cannot read', () => {
    writeFileSync(join(dir, 'bad.json'), '{ paused: nope');
    expect(new FileControls(join(dir, 'bad.json')).load().paused).toBe(true);
    writeFileSync(join(dir, 'odd.json'), '{"paused": "no"}');
    expect(new FileControls(join(dir, 'odd.json')).load().paused).toBe(true);
  });
});
