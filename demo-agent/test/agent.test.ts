import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PaymentBlockedError, type Rx402Client } from '@sodi/rx402';
import { describe, expect, it } from 'vitest';

import { runCycle } from '../src/agent.js';
import { FeedLog } from '../src/feed.js';

const agent = { name: 't', chainId: 46630, pool: '0x8cddbb1C33ce49aB72FD1765649835935604BF76' as const, startedAt: 0, intervalSeconds: 300 };
const S1 = '0x00000000000000000000000000000000000000a1';
const S2 = '0x00000000000000000000000000000000000000a2';
const TX = `0x${'ab'.repeat(32)}`;

/** A stand-in for Rx402Client: scripted responses, and a session that changes when told to. */
function fakeClient(script: (path: string) => { rotate?: boolean; error?: Error; stealth?: boolean }) {
  let session = { address: S1, openedAt: 1, budget: '20000', fundingTx: `0x${'01'.repeat(32)}` };
  return {
    currentSession: () => session,
    fetch: async (url: string) => {
      const path = new URL(url).pathname;
      const s = script(path);
      if (s.error) throw s.error;
      if (s.rotate) session = { address: S2, openedAt: 2, budget: '20000', fundingTx: `0x${'02'.repeat(32)}` };
      const receipt = Buffer.from(JSON.stringify({ success: true, transaction: TX })).toString('base64');
      return {
        response: new Response(JSON.stringify({ symbol: 'TSLA', priceInWeth: 0.00089 }), { headers: { 'payment-response': receipt } }),
        payment: { amount: 1000n, payTo: '0x5ea1', from: session.address, stealth: s.stealth ?? false },
      };
    },
  } as unknown as Rx402Client;
}

describe('demo agent cycle', () => {
  it('buys a quote each cycle and the market summary every third', async () => {
    const feed = new FeedLog(undefined, agent);
    const seen: string[] = [];
    const client = fakeClient((p) => (seen.push(p), { stealth: p.startsWith('/quote') }));
    await runCycle({ client, feed, apiBase: 'http://x', cycle: 0 });
    await runCycle({ client, feed, apiBase: 'http://x', cycle: 1 });
    expect(seen).toEqual(['/quote/TSLA', '/market', '/quote/AMZN']);
    const pays = feed.get().events.filter((e) => e.kind === 'payment');
    expect(pays).toHaveLength(3);
    expect(pays[0]).toMatchObject({ api: 'quote TSLA', amount: '1000', stealth: true, txHash: TX });
  });

  it('logs a new session before the payment it funded', async () => {
    const feed = new FeedLog(undefined, agent);
    await runCycle({ client: fakeClient(() => ({ rotate: true })), feed, apiBase: 'http://x', cycle: 1 });
    expect(feed.get().events.map((e) => e.kind)).toEqual(['session', 'payment']);
    expect(feed.get().events[0]).toMatchObject({ session: S2 });
  });

  it('reports a pause once, not every cycle', async () => {
    const feed = new FeedLog(undefined, agent);
    const client = fakeClient(() => ({ error: new PaymentBlockedError('paused', 'paused') }));
    for (let i = 1; i <= 3; i++) await runCycle({ client, feed, apiBase: 'http://x', cycle: i });
    expect(feed.get().events).toEqual([expect.objectContaining({ kind: 'notice', message: 'Paused by the owner (paused).' })]);
  });

  it('says plainly when it runs out of funds', async () => {
    const feed = new FeedLog(undefined, agent);
    await runCycle({ client: fakeClient(() => ({ error: new Error('no pool deposit with at least 20000 available; deposit more') })), feed, apiBase: 'http://x', cycle: 1 });
    expect(feed.get().events[0]).toMatchObject({ message: 'Out of funds: the pool needs a top-up.' });
  });

  it('keeps the feed across restarts, and never stores keys', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sodi-feed-')), 'feed.json');
    const feed = new FeedLog(file, agent);
    await runCycle({ client: fakeClient(() => ({})), feed, apiBase: 'http://x', cycle: 1 });
    const again = new FeedLog(file, { ...agent, startedAt: 99 });
    expect(again.get().events).toHaveLength(1);
    expect(again.get().agent.startedAt).toBe(99);
    expect(JSON.stringify(again.get())).not.toMatch(/privateKey|mnemonic/);
  });
});
