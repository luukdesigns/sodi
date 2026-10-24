import { describe, expect, it } from 'vitest';

import { checkDelivery, deliveryDigest, digestingStream } from '../../src/digest.js';
import { RateLimiter } from '../../src/guards.js';
import { CreditKeeper } from '../../src/keeper.js';

const streamOf = (parts: string[], failAfter?: number) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      parts.forEach((p, i) => {
        if (failAfter !== undefined && i >= failAfter) return;
        c.enqueue(new TextEncoder().encode(p));
      });
      if (failAfter !== undefined) c.error(new Error('upstream broke, prompt was: secret'));
      else c.close();
    },
  });

describe('delivery digest', () => {
  it('appends the sha256 of every streamed byte as a final SSE comment', async () => {
    const parts = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n'];
    const text = await new Response(digestingStream(streamOf(parts))).text();
    expect(text.startsWith(parts.join(''))).toBe(true);
    expect(text.endsWith(`: sodi-delivery-digest ${deliveryDigest(parts.join(''))}\n\n`)).toBe(true);
    expect(checkDelivery(text)).toEqual({ ok: true, digest: deliveryDigest(parts.join('')) });
    expect(checkDelivery(text.replace('"a":1', '"a":2')).ok).toBe(false);
  });

  it('ends a broken stream cleanly, without the error', async () => {
    const text = await new Response(digestingStream(streamOf(['data: 1\n\n', 'data: 2\n\n'], 1))).text();
    expect(text).toContain('sodi-delivery-error');
    expect(text).not.toContain('secret');
    expect(checkDelivery(text).ok).toBe(true);
  });

  it('checks a non-streamed body against its header', () => {
    expect(checkDelivery('{"x":1}', deliveryDigest('{"x":1}')).ok).toBe(true);
    expect(checkDelivery('{"x":2}', deliveryDigest('{"x":1}')).ok).toBe(false);
  });
});

describe('rate limit', () => {
  it('limits each paying address separately, over a sliding window', () => {
    let t = 0;
    const l = new RateLimiter(2, 1000, () => t);
    expect([l.take('0xA'), l.take('0xa'), l.take('0xA')]).toEqual([true, true, false]);
    expect(l.take('0xB')).toBe(true);
    t = 1001;
    expect(l.take('0xA')).toBe(true);
  });
});

describe('credit keeper', () => {
  it('tops up below the threshold, once per cooldown, and stops quoting below the floor', async () => {
    let remaining = 30;
    const asked: [number, number][] = [];
    let t = 0;
    const keeper = new CreditKeeper({
      source: { remainingCredits: async () => remaining },
      topUp: { topUp: async (amount, rem) => void asked.push([amount, rem]) },
      thresholdUsd: 20,
      topUpUsd: 50,
      floorUsd: 2,
      cooldownMs: 1000,
      now: () => t,
    });
    expect(keeper.canServe()).toBe(true); // unknown balance: serve
    await keeper.tick();
    expect(asked).toEqual([]);
    remaining = 10;
    await keeper.tick();
    await keeper.tick();
    expect(asked).toEqual([[50, 10]]);
    remaining = 1;
    t = 2000;
    await keeper.tick();
    expect(asked).toEqual([[50, 10], [50, 1]]);
    expect(keeper.canServe()).toBe(false);
    remaining = 51;
    await keeper.tick();
    expect(keeper.canServe()).toBe(true);
  });
});
