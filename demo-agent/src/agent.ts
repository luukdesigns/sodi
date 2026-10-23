/**
 * The demo agent's job: every cycle, buy a stock quote (from an API that offers stealth) and, every
 * third cycle, a market summary (an ordinary API), paying privately with rx402.
 */
import { PaymentBlockedError, type Rx402Client } from '@sodi/rx402';

import { STOCKS } from './apis.js';
import type { FeedLog } from './feed.js';

export async function runCycle(opts: { client: Rx402Client; feed: FeedLog; apiBase: string; cycle: number; now?: () => number }) {
  const { client, feed } = opts;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const symbols = Object.keys(STOCKS);
  const calls: [string, string][] = [[`quote ${symbols[opts.cycle % symbols.length]}`, `/quote/${symbols[opts.cycle % symbols.length]}`]];
  if (opts.cycle % 3 === 0) calls.push(['market summary', '/market']);

  for (const [api, path] of calls) {
    const before = client.currentSession()?.address;
    try {
      const { response, payment } = await client.fetch(`${opts.apiBase}${path}`);
      const session = client.currentSession();
      if (session && session.address !== before) {
        feed.add({ kind: 'session', at: session.openedAt, session: session.address, budget: session.budget, fundingTx: session.fundingTx });
      }
      if (!response.ok || !payment) {
        notice(feed, now, `${api}: the API answered ${response.status}`);
        continue;
      }
      const receipt = response.headers.get('payment-response') ?? response.headers.get('x-payment-response');
      const txHash = receipt ? (JSON.parse(Buffer.from(receipt, 'base64').toString()) as { transaction?: `0x${string}` }).transaction : undefined;
      feed.add({
        kind: 'payment',
        at: now(),
        api,
        amount: payment.amount.toString(),
        session: payment.from,
        payTo: payment.payTo,
        stealth: payment.stealth,
        txHash,
        result: (await response.text()).slice(0, 300),
      });
    } catch (err) {
      const message =
        err instanceof PaymentBlockedError
          ? `Paused by the owner (${err.reason.replace(/-/g, ' ')}).`
          : /no pool deposit with at least/.test((err as Error).message)
            ? 'Out of funds: the pool needs a top-up.'
            : `${api} failed: ${(err as Error).message.split('\n')[0]}`;
      notice(feed, now, message);
      return;
    }
  }
}

function notice(feed: FeedLog, now: () => number, message: string) {
  if (feed.lastNotice() !== message) feed.add({ kind: 'notice', at: now(), message });
}
