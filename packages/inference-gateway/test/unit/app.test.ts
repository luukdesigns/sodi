/**
 * The gateway against the mock OpenRouter with a stand-in for on-chain payment, so the HTTP behaviour
 * can be checked quickly. The real x402 round trip from an rx402 session is in test/e2e.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createGateway } from '../../src/app.js';
import { ModelCatalog } from '../../src/catalog.js';
import { DIGEST_HEADER, checkDelivery, deliveryDigest } from '../../src/digest.js';
import { GuardModelClassifier, RateLimiter } from '../../src/guards.js';
import { PaymentError, type PaymentGate } from '../../src/payments.js';
import { Upstream } from '../../src/upstream.js';
import { API_KEY, type MockOpenRouter, answerFor, startMockOpenRouter } from '../mock-openrouter.js';

const SECRET = 'the launch codes are 0000';

class FakePayments {
  settled: string[] = [];
  released: string[] = [];
  paymentRequired(amount: bigint, resource: string, description: string) {
    return { x402Version: 2, accepts: [{ scheme: 'exact', amount: amount.toString(), resource, description }] };
  }
  async verify(header: string, amount: bigint) {
    const [from, paid] = header.split(':');
    if (BigInt(paid ?? 0) < amount) throw new PaymentError('underpaid');
    return {
      from: from as `0x${string}`,
      value: BigInt(paid!),
      stealth: true,
      settle: async () => (this.settled.push(from!), '0x' + 'ab'.repeat(32)) as `0x${string}`,
      release: () => void this.released.push(from!),
    };
  }
}

describe('gateway (mock upstream, stand-in payments)', () => {
  let mock: MockOpenRouter;
  let payments: FakePayments;
  let app: ReturnType<typeof createGateway>;
  const logged: string[] = [];
  const spies: { mockRestore(): void }[] = [];

  beforeAll(async () => {
    mock = await startMockOpenRouter();
    const upstream = new Upstream({ baseUrl: mock.url, apiKey: API_KEY });
    payments = new FakePayments();
    app = createGateway({
      upstream,
      catalog: new ModelCatalog(upstream, ['test/small', 'test/retaining', 'openrouter/auto']),
      payments: payments as unknown as PaymentGate,
      limiter: new RateLimiter(3, 60_000),
      abuse: new GuardModelClassifier(upstream),
      marginBps: 1000,
      limits: { defaultMaxTokens: 256, maxTokens: 4096 },
      network: 'eip155:46630',
    });
    // Anything the gateway prints during these tests is captured: it must print nothing.
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) spies.push(vi.spyOn(console, m).mockImplementation((...a) => void logged.push(a.map(String).join(' '))));
  });

  afterAll(async () => {
    for (const s of spies) s.mockRestore();
    await mock.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const chat = (extra: Record<string, unknown> = {}) => ({ model: 'test/small', messages: [{ role: 'user', content: SECRET }], max_tokens: 64, ...extra });

  it('quotes with a 402 before calling the upstream', async () => {
    const before = mock.received.length;
    const res = await post('/v1/chat/completions', chat());
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(BigInt(body.accepts[0].amount)).toBeGreaterThan(0n);
    expect(mock.received.slice(before).filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('forwards only the sanitized body with our routing policy, and none of the client headers', async () => {
    const quoted = BigInt((await (await post('/v1/chat/completions', chat())).json()).accepts[0].amount);
    const res = await post('/v1/chat/completions', chat({ user: 'alice', metadata: { team: 'x' } }), {
      'payment-signature': `0x1111111111111111111111111111111111111111:${quoted}`,
      cookie: 'session=abc',
      'x-forwarded-for': '203.0.113.7',
      'user-agent': 'AliceAgent/1.0',
      'openai-organization': 'org-alice',
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(res.headers.get(DIGEST_HEADER)).toBe(deliveryDigest(text));
    expect(JSON.parse(text).choices[0].message.content).toBe(answerFor({ model: 'test/small', max_tokens: 64 }));

    const sent = mock.received.filter((r) => r.path === '/chat/completions' && r.body?.model === 'test/small').at(-1)!;
    expect(sent.body).toEqual({
      model: 'test/small',
      messages: [{ role: 'user', content: SECRET }],
      max_tokens: 64,
      provider: { data_collection: 'deny', require_parameters: true },
    });
    const headerValues = JSON.stringify(sent.headers);
    for (const leaked of ['session=abc', '203.0.113.7', 'AliceAgent', 'org-alice', 'payment-signature', '0x1111']) expect(headerValues).not.toContain(leaked);
    expect(sent.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('refuses without charging when no no-retention provider serves the model', async () => {
    const res = await post('/v1/chat/completions', chat({ model: 'test/retaining' }), { 'payment-signature': '0x2222222222222222222222222222222222222222:999999' });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain('not charged');
    expect(text).not.toContain(SECRET); // the upstream's error quoted the prompt
    expect(payments.released).toContain('0x2222222222222222222222222222222222222222');
    expect(payments.settled).not.toContain('0x2222222222222222222222222222222222222222');
  });

  it('runs the abuse hook before forwarding, and refuses without charging', async () => {
    const before = mock.received.filter((r) => r.body?.model === 'test/small').length;
    const res = await post('/v1/chat/completions', chat({ messages: [{ role: 'user', content: 'BLOCKME please' }] }), { 'payment-signature': '0x3333333333333333333333333333333333333333:999999' });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('S2');
    expect(mock.received.filter((r) => r.body?.model === 'test/small').length).toBe(before);
    expect(payments.settled).not.toContain('0x3333333333333333333333333333333333333333');
  });

  it('streams Anthropic-format responses with the digest at the end', async () => {
    const body = { model: 'test/small', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] };
    const res = await post('/v1/messages', body, { 'payment-signature': '0x4444444444444444444444444444444444444444:999999' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: message_stop');
    expect(checkDelivery(text).ok).toBe(true);
  });

  it('refuses models that are not allowlisted or have no fixed price', async () => {
    expect((await post('/v1/chat/completions', chat({ model: 'test/not-allowlisted' }))).status).toBe(400);
    expect((await post('/v1/chat/completions', chat({ model: 'openrouter/auto' }))).status).toBe(400);
  });

  it('rate-limits per paying address', async () => {
    const h = { 'payment-signature': '0x5555555555555555555555555555555555555555:999999' };
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post('/v1/chat/completions', chat(), h)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((await post('/v1/chat/completions', chat(), { 'payment-signature': '0x6666666666666666666666666666666666666666:999999' })).status).toBe(200);
  });

  it('logged nothing at all', () => {
    expect(logged).toEqual([]);
  });
});
