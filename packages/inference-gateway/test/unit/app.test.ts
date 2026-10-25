/**
 * The gateway against the mock OpenRouter with a stand-in for on-chain payment, so the HTTP behaviour
 * can be checked quickly. The real x402 round trip from an rx402 session is in test/e2e.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createGateway } from '../../src/app.js';
import { ModelCatalog } from '../../src/catalog.js';
import { CreditLedger, upstreamCost } from '../../src/credits.js';
import { DIGEST_HEADER, checkDelivery, deliveryDigest } from '../../src/digest.js';
import { GuardModelClassifier, RateLimiter } from '../../src/guards.js';
import { PaymentError, type PaymentGate } from '../../src/payments.js';
import { Upstream } from '../../src/upstream.js';
import { API_KEY, MOCK_COST_USD, type MockOpenRouter, answerFor, startMockOpenRouter } from '../mock-openrouter.js';

const SECRET = 'the launch codes are 0000';

class FakePayments {
  settled: string[] = [];
  released: string[] = [];
  paymentRequired(amount: bigint, resource: string, description: string) {
    return { x402Version: 2, accepts: [{ scheme: 'exact', amount: amount.toString(), resource, description }] };
  }
  async verify(header: string, amount: bigint | ((from: `0x${string}`) => bigint)) {
    const [from, paid] = header.split(':');
    const due = typeof amount === 'function' ? amount(from as `0x${string}`) : amount;
    if (BigInt(paid ?? 0) < due) throw new PaymentError('underpaid');
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
      catalog: new ModelCatalog(upstream, ['test/small', 'test/retaining', 'openrouter/auto', 'test/spread']),
      payments: payments as unknown as PaymentGate,
      limiter: new RateLimiter(3, 60_000),
      abuse: new GuardModelClassifier(upstream),
      marginBps: 1000,
      credits: new CreditLedger(),
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
      // Routed no higher than the price it was quoted at, cheapest qualifying provider first.
      provider: { data_collection: 'deny', require_parameters: true, sort: 'price', max_price: { prompt: 0.000001 * 1e6, completion: 0.000002 * 1e6 } },
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

  it('quotes at a ceiling over the cheapest providers, and routes no higher than it', async () => {
    const body = { model: 'test/spread', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1000 };
    const quoted = BigInt((await (await post('/v1/chat/completions', body)).json()).accepts[0].amount);
    const res = await post('/v1/chat/completions', body, { 'payment-signature': `0x7777777777777777777777777777777777777777:${quoted}` });
    expect(res.status).toBe(200);
    // The fifth-cheapest provider sets the ceiling: 0.15 and 0.5 USD per million tokens.
    expect(mock.received.at(-1)!.body!.provider).toMatchObject({ sort: 'price', max_price: { prompt: 0.00000015 * 1e6, completion: 0.0000005 * 1e6 } });
    // 1000 output tokens at the ceiling alone is 0.0005 USD; the listed (cheapest) price would quote 0.0001.
    expect(quoted).toBeGreaterThan(500n);
  });

  it('refuses Anthropic messages with a system role before quoting', async () => {
    const res = await post('/v1/messages', { model: 'test/small', max_tokens: 50, messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'hi' }] });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('roles');
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

  it('credits the change from an overpaid request to the same payer, and only to it', async () => {
    const payer = '0x8888888888888888888888888888888888888888';
    const body = chat({ max_tokens: 2000 });
    const quoteFor = async (who?: string) => BigInt((await (await post('/v1/chat/completions', body, who ? { 'sodi-payer': who } : {})).json()).accepts[0].amount);
    const full = await quoteFor();
    expect(await quoteFor(payer)).toBe(full); // no credit yet

    const first = await post('/v1/chat/completions', body, { 'payment-signature': `${payer}:${full}` });
    expect(first.status).toBe(200);
    // Charged what the upstream reported, plus the 10% margin; the rest is credit.
    const charged = BigInt(Math.ceil(MOCK_COST_USD * 1e6 * 1.1));
    expect(BigInt(first.headers.get('sodi-credit')!)).toBe(full - charged);

    // Its next quote is reduced by the credit (to the 1-unit minimum here); another payer's isn't.
    const reduced = await quoteFor(payer);
    // The credit (full - charged) covers all but `charged` of the next identical request.
    expect(reduced).toBe(charged);
    expect(await quoteFor('0x9999999999999999999999999999999999999999')).toBe(full);
    // Claiming the payer but paying from another address: the reduced amount is underpaid.
    expect((await post('/v1/chat/completions', body, { 'sodi-payer': payer, 'payment-signature': `0x9999999999999999999999999999999999999999:${reduced}` })).status).toBe(402);

    const second = await post('/v1/chat/completions', body, { 'payment-signature': `${payer}:${reduced}` });
    expect(second.status).toBe(200);
    // Paid `charged` plus the credit it used (the full quote in all), charged `charged` again: same change.
    expect(BigInt(second.headers.get('sodi-credit')!)).toBe(full - charged);
  });

  it('reads the upstream cost from a body or a stream, ignoring text in the answer', () => {
    expect(upstreamCost('{"choices":[{"message":{"content":"the \\"cost\\": 99 is fake"}}],"usage":{"cost":0.000059607,"cost_details":{"upstream_inference_cost":0.000059607}}}')).toBe(0.000059607);
    expect(upstreamCost('data: {"x":1}\n\ndata: {"usage":{"cost":1.5e-5}}\n\n')).toBe(0.000015);
    expect(upstreamCost('{"usage":{}}')).toBeUndefined();
  });

  it('logged nothing at all', () => {
    expect(logged).toEqual([]);
  });
});
