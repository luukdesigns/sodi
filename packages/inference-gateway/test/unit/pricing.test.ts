import { describe, expect, it } from 'vitest';

import { priceCeiling } from '../../src/catalog.js';
import { marginShareOfRevenueBps } from '../../src/sweep.js';
import { PricingError, estimateInputTokens, quote } from '../../src/pricing.js';
import { RequestError, parseRequest, promptText } from '../../src/requests.js';
import type { ModelInfo } from '../../src/upstream.js';

const limits = { defaultMaxTokens: 512, maxTokens: 4096 };
const small: ModelInfo = { id: 'test/small', pricing: { prompt: '0.000001', completion: '0.000002' }, contextLength: 32_000, maxCompletionTokens: 4096 };

describe('requests', () => {
  it('keeps only priced fields and always sets max_tokens', () => {
    const r = parseRequest(
      'openai',
      { model: 'test/small', messages: [{ role: 'user', content: 'hi' }], user: 'alice@example.com', models: ['x/expensive'], plugins: [{ id: 'web' }], provider: { data_collection: 'allow' }, temperature: 0.2 },
      limits,
    );
    expect(r.body).toEqual({ model: 'test/small', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, max_tokens: 512 });
    expect(r.maxTokens).toBe(512);
  });

  it('takes the stricter of max_tokens and max_completion_tokens, and refuses over the cap', () => {
    expect(parseRequest('openai', { model: 'm', messages: [{}], max_tokens: 300, max_completion_tokens: 200 }, limits).maxTokens).toBe(200);
    expect(() => parseRequest('openai', { model: 'm', messages: [{}], max_tokens: 5000 }, limits)).toThrow(RequestError);
    expect(() => parseRequest('openai', { model: 'm', messages: [{}], n: 3 }, limits)).toThrow(/n must be 1/);
  });

  it('accepts Anthropic thinking only inside max_tokens', () => {
    const ok = parseRequest('anthropic', { model: 'm', system: 'be brief', messages: [{ role: 'user', content: 'x' }], max_tokens: 2000, thinking: { type: 'enabled', budget_tokens: 1024 } }, limits);
    expect(ok.body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(() => parseRequest('anthropic', { model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 1000, thinking: { type: 'enabled', budget_tokens: 1024 } }, limits)).toThrow(/budget_tokens/);
    expect(() => parseRequest('anthropic', { model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 1000, thinking: { type: 'adaptive' } }, limits)).toThrow(/thinking.type/);
  });

  it('collects the prompt text for the abuse hook', () => {
    const r = parseRequest('anthropic', { model: 'm', system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image' }] }, { role: 'assistant', content: 'b' }] }, limits);
    expect(promptText(r)).toBe('sys\na\nb');
  });
});

describe('pricing', () => {
  it('prices input plus the full max_tokens of output, plus the margin, rounded up', () => {
    const r = parseRequest('openai', { model: 'test/small', messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 }, limits);
    const input = estimateInputTokens(r);
    const q = quote(r, small, 1000);
    // (input × 1e-6 + 100 × 2e-6) USD × 1.1, in micro-USD, rounded up
    expect(q.amount).toBe(BigInt(Math.ceil((input * 1 + 100 * 2) * 1.1)));
    expect(q).toMatchObject({ inputTokens: input, maxOutputTokens: 100 });
  });

  it('estimates high: one token per three bytes, plus per-message overhead', () => {
    const text = 'x'.repeat(3000);
    const r = parseRequest('openai', { model: 'm', messages: [{ role: 'user', content: text }] }, limits);
    expect(estimateInputTokens(r)).toBeGreaterThan(1000);
    expect(estimateInputTokens(r)).toBeLessThan(1100);
  });

  it('adds the per-request price, and never quotes zero', () => {
    const r = parseRequest('openai', { model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 1 }, limits);
    const withRequest = quote(r, { ...small, pricing: { ...small.pricing, request: '0.01' } }, 0);
    expect(withRequest.amount).toBeGreaterThan(10_000n);
    expect(quote(r, { ...small, pricing: { prompt: '0', completion: '0' } }, 0).amount).toBe(1n);
  });

  it('refuses what it cannot quote up front', () => {
    const r = parseRequest('openai', { model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 4096 }, limits);
    expect(() => quote(r, { ...small, pricing: { prompt: '-1', completion: '-1' } }, 0)).toThrow(PricingError);
    expect(() => quote(r, { ...small, contextLength: 4000 }, 0)).toThrow(/context/);
    expect(() => quote(r, { ...small, maxCompletionTokens: 2048 }, 0)).toThrow(/limit of 2048/);
  });
});

describe('price ceiling', () => {
  const p = (prompt: string, completion: string, request?: string) => ({ prompt, completion, ...(request ? { request } : {}) });
  it('is the most expensive of the n cheapest providers, per component', () => {
    const providers = [p('0.0000006', '0.0000024'), p('0.00000002', '0.0000001'), p('0.00000005', '0.0000003'), p('0.00000004', '0.0000002', '0.001')];
    expect(priceCeiling(providers, 3)).toEqual(p('0.00000005', '0.0000003', '0.001'));
    expect(priceCeiling(providers, 1)).toEqual(p('0.00000002', '0.0000001'));
    expect(priceCeiling(providers, 10)).toEqual(p('0.0000006', '0.0000024', '0.001'));
    expect(priceCeiling([], 5)).toBeUndefined();
  });
});

describe('margin share', () => {
  it('is the share of the margin part of revenue', () => {
    // 10% margin: revenue is 1.1x cost, so the margin is 1/11 of revenue; half of it is 454 bps.
    expect(marginShareOfRevenueBps(5000, 1000)).toBe(454);
    expect(marginShareOfRevenueBps(10_000, 1000)).toBe(909);
    expect(marginShareOfRevenueBps(5000, 0)).toBe(0);
    expect(() => marginShareOfRevenueBps(10_001, 1000)).toThrow();
  });
});
