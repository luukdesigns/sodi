import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileControls, MemoryStore, type WalletState } from '@sodi/rx402';
import type { Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startDashboard } from '../src/server.js';
import { buildState, parseControls } from '../src/state.js';

const NOW = 1_800_000_000;
const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;

const wallet: WalletState = {
  version: 1,
  notes: [{ scope: '1', depositIndex: 0, label: '42', value: '50000', spendCount: 2, depositTx: H(1) }],
  depositCounts: { '1': 1 },
  sessions: [
    { address: A(0xa1), privateKey: H(0xdead1), budget: '49750', spent: '10000', payments: 2, openedAt: NOW - 7200, fundingTx: H(2) },
    { address: A(0xa2), privateKey: H(0xdead2), budget: '49750', spent: '5000', payments: 1, openedAt: NOW - 600, fundingTx: H(3) },
  ],
  payments: [
    { at: NOW - 90_000, resource: 'https://old.example/x', amount: '7000', payTo: A(0xb1), stealth: false, session: A(0xa0) },
    { at: NOW - 7000, resource: 'https://api.example/quote', amount: '5000', payTo: A(0xb1), stealth: false, session: A(0xa1) },
    { at: NOW - 6000, resource: 'https://shop.example/data', amount: '5000', payTo: A(0xc1), stealth: true, session: A(0xa1) },
    { at: NOW - 500, resource: 'https://shop.example/data', amount: '5000', payTo: A(0xc2), stealth: true, session: A(0xa2) },
  ],
};

const dir = mkdtempSync(join(tmpdir(), 'sodi-dash-'));
const controls = new FileControls(join(dir, 'controls.json'));
const store = new MemoryStore();
store.save(wallet);
const sources = {
  store,
  controls,
  chainId: 46630,
  asset: A(0x05d6),
  explorer: 'https://explorer.testnet.chain.robinhood.com',
  balanceOf: async (a: Address) => (a === A(0xa1) ? 39750n : 44750n),
  approvalOf: async (label: string) => (label === '42' ? 'approved' : undefined),
  now: () => NOW,
};

describe('dashboard state', () => {
  it('totals the pool, sessions and payments', async () => {
    const s = await buildState(sources);
    expect(s.pool.balance).toBe('50000');
    expect(s.pool.deposits[0]).toMatchObject({ remaining: '50000', withdrawals: 2, approval: 'approved' });
    expect(s.totals).toEqual({ spentLast24h: '15000', spentAllTime: '22000', payments: 4, stealthPayments: 2, heldInSessions: '84500' });
    expect(s.sessions[0]).toMatchObject({ address: A(0xa2), current: true, balance: '44750' });
    expect(s.payments[0]!.at).toBe(NOW - 500);
  });

  it('never includes session private keys', async () => {
    expect(JSON.stringify(await buildState(sources))).not.toMatch(/dead1|dead2|privateKey/);
  });

  it('still renders when the chain or the approval service is unreachable', async () => {
    const s = await buildState({ ...sources, balanceOf: async () => Promise.reject(new Error('rpc down')), approvalOf: async () => Promise.reject(new Error('down')) });
    expect(s.sessions[0]!.balance).toBeNull();
    expect(s.pool.deposits[0]!.approval).toBeNull();
  });
});

describe('controls validation', () => {
  it('accepts a full update and drops empty fields', () => {
    expect(parseControls({ paused: false, maxPaymentAmount: '50000', dailyLimit: '', allowedHosts: ['API.example.com'] })).toEqual({
      paused: false,
      maxPaymentAmount: '50000',
      allowedHosts: ['api.example.com'],
    });
  });

  it('rejects bad input', () => {
    expect(() => parseControls({})).toThrow(/paused/);
    expect(() => parseControls({ paused: 'yes' })).toThrow(/paused/);
    expect(() => parseControls({ paused: false, dailyLimit: '1.5' })).toThrow(/whole number/);
    expect(() => parseControls({ paused: false, dailyLimit: -1 })).toThrow(/whole number/);
    expect(() => parseControls({ paused: false, allowedHosts: ['https://x.com/path'] })).toThrow(/host/);
  });
});

describe('dashboard server', () => {
  const PORT = 18620;
  const OWNER = 'owner-token-for-tests';
  const VIEWER = 'viewer-token-for-tests';
  let srv: ReturnType<typeof startDashboard>;
  beforeAll(() => {
    srv = startDashboard({ port: PORT, sources, saveControls: (c) => controls.save(c), ownerToken: OWNER, viewerToken: VIEWER });
  });
  afterAll(() => srv.server.close());

  const call = (method: string, path: string, opts: { token?: string; body?: unknown; host?: string } = {}) =>
    new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: PORT,
          method,
          path,
          headers: {
            host: opts.host ?? `127.0.0.1:${PORT}`,
            ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
            'content-type': 'application/json',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
        },
      );
      req.on('error', reject);
      if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
      req.end();
    });

  it('serves the app with a strict content security policy', async () => {
    const r = await call('GET', '/');
    expect(r.status).toBe(200);
    expect(r.body).toContain('<title>Sodi Dashboard</title>');
    expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('requires a token for data', async () => {
    expect((await call('GET', '/api/state')).status).toBe(401);
    expect((await call('GET', '/api/state', { token: 'wrong' })).status).toBe(401);
    const r = await call('GET', '/api/state', { token: OWNER });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).role).toBe('owner');
  });

  it('refuses requests addressed to other host names (DNS rebinding)', async () => {
    expect((await call('GET', '/api/state', { token: OWNER, host: 'evil.example:8480' })).status).toBe(421);
  });

  it('lets the read-only link view but not change anything', async () => {
    const r = await call('GET', '/api/state', { token: VIEWER });
    expect(JSON.parse(r.body).role).toBe('viewer');
    expect((await call('PUT', '/api/controls', { token: VIEWER, body: { paused: true } })).status).toBe(403);
    expect(controls.load().paused).toBe(false);
  });

  it('saves owner controls to the file the agent reads', async () => {
    const r = await call('PUT', '/api/controls', { token: OWNER, body: { paused: true, dailyLimit: '20000' } });
    expect(r.status).toBe(200);
    expect(controls.load()).toMatchObject({ paused: true, dailyLimit: '20000' });
    expect((await call('PUT', '/api/controls', { token: OWNER, body: { paused: 'maybe' } })).status).toBe(400);
    expect(controls.load().paused).toBe(true);
  });
});
