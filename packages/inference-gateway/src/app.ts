/**
 * The gateway: OpenAI- and Anthropic-format inference, paid per request over x402.
 *
 *   1. price the request from its body (before anything is sent upstream) and answer 402 with it
 *   2. on the paid retry: check the payment, the payer's rate limit and the abuse hook
 *   3. send it upstream on our key, restricted to providers that don't keep prompts
 *   4. once the upstream accepts, settle the payment, then deliver with a digest of the bytes sent
 *
 * Any refusal in 2 or 3 leaves the payment unsettled, so the agent isn't charged for it.
 *
 * Nothing about a request is logged, on success or on error: there is no logger, the error handler
 * returns a fixed message, and upstream error bodies (which can quote the prompt) are never read
 * beyond a status check or passed on.
 */
import { Hono, type Context } from 'hono';

import type { ModelCatalog } from './catalog.js';
import { DIGEST_HEADER, deliveryDigest, digestingStream } from './digest.js';
import { type AbuseHook, type RateLimiter, allowAll } from './guards.js';
import type { CreditKeeper } from './keeper.js';
import { PaymentError, type PaymentGate } from './payments.js';
import { PricingError, quote } from './pricing.js';
import { type Format, type Limits, RequestError, parseRequest, promptText } from './requests.js';
import { type Upstream, UpstreamError } from './upstream.js';

export interface GatewayConfig {
  upstream: Upstream;
  catalog: ModelCatalog;
  payments: PaymentGate;
  limiter: RateLimiter;
  abuse?: AbuseHook;
  keeper?: CreditKeeper;
  /** Margin on top of the upstream price, in basis points. */
  marginBps: number;
  limits: Limits;
  /** Largest request body accepted, in bytes. */
  maxBodyBytes?: number;
  /** Public base URL, for the `resource` in 402s when the gateway runs behind a proxy. */
  publicUrl?: string;
  /** For the PAYMENT-RESPONSE header. */
  network: string;
}

const PATHS = { openai: '/chat/completions', anthropic: '/messages' } as const;

function error(format: Format, status: number, message: string, extra: Record<string, unknown> = {}): Response {
  const body =
    format === 'anthropic'
      ? { type: 'error', error: { type: status === 402 ? 'payment_required' : status === 429 ? 'rate_limit_error' : 'invalid_request_error', message }, ...extra }
      : { error: { message, type: status === 402 ? 'payment_required' : status === 429 ? 'rate_limit_exceeded' : 'invalid_request_error' }, ...extra };
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export function createGateway(config: GatewayConfig): Hono {
  const app = new Hono();
  const abuse = config.abuse ?? allowAll;
  const maxBody = config.maxBodyBytes ?? 1_000_000;

  // Fixed message, nothing logged: the default handler prints the error, which could carry request data.
  app.onError(() => new Response(JSON.stringify({ error: { message: 'internal error' } }), { status: 500, headers: { 'content-type': 'application/json' } }));
  app.notFound(() => new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404, headers: { 'content-type': 'application/json' } }));

  app.get('/health', (c) => c.json({ ok: true, serving: config.keeper?.canServe() ?? true }));

  app.get('/v1/models', async (c) => {
    const data = [];
    for (const id of config.catalog.allowlist) {
      const m = await config.catalog.get(id).catch(() => undefined);
      if (m) data.push({ id, object: 'model', pricing: m.pricing, context_length: m.contextLength, margin_bps: config.marginBps });
    }
    return c.json({ object: 'list', data });
  });

  app.post('/v1/chat/completions', (c) => handle(c, 'openai'));
  app.post('/v1/messages', (c) => handle(c, 'anthropic'));

  async function handle(c: Context, format: Format): Promise<Response> {
    if (config.keeper && !config.keeper.canServe()) return error(format, 503, 'the gateway is temporarily out of upstream credit; try again later');

    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > maxBody) return error(format, 413, `request body is over ${maxBody} bytes`);
    const text = await c.req.text();
    if (Buffer.byteLength(text) > maxBody) return error(format, 413, `request body is over ${maxBody} bytes`);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return error(format, 400, 'body is not valid JSON');
    }

    let req;
    let price;
    try {
      req = parseRequest(format, raw, config.limits);
      const model = await config.catalog.get(req.model).catch(() => {
        throw new UpstreamError(503, 'unavailable');
      });
      if (!model) return error(format, 400, `model ${JSON.stringify(req.model).slice(0, 120)} is not offered here; see GET /v1/models`);
      price = quote(req, model, config.marginBps);
    } catch (err) {
      if (err instanceof RequestError || err instanceof PricingError) return error(format, 400, err.message);
      if (err instanceof UpstreamError) return error(format, 503, 'model prices are unavailable right now');
      throw err;
    }

    const resource = `${config.publicUrl ?? new URL(c.req.url).origin}/v1${PATHS[format]}`;
    const description = `${req.model}: up to ${price.maxOutputTokens} output tokens, about ${price.inputTokens} input tokens (estimated high)`;
    const header = c.req.header('payment-signature') ?? c.req.header('x-payment');
    if (!header) return Response.json(config.payments.paymentRequired(price.amount, resource, description), { status: 402, headers: { 'cache-control': 'no-store' } });

    let payment;
    try {
      payment = await config.payments.verify(header, price.amount);
    } catch (err) {
      if (!(err instanceof PaymentError)) throw err;
      return Response.json({ ...config.payments.paymentRequired(price.amount, resource, description), error: err.message }, { status: 402, headers: { 'cache-control': 'no-store' } });
    }

    if (!config.limiter.take(payment.from)) {
      payment.release();
      return error(format, 429, `at most ${config.limiter.limit} requests per ${config.limiter.windowMs / 1000}s from one paying address`);
    }

    const verdict = await abuse.check({ request: req, prompt: promptText(req) }).catch(() => ({ allow: false as const, reason: 'the abuse check failed' }));
    if (!verdict.allow) {
      payment.release();
      return error(format, 403, verdict.reason);
    }

    let upstream: Response;
    try {
      upstream = await config.upstream.send(PATHS[format], req.body, req.stream ? c.req.raw.signal : undefined);
    } catch (err) {
      payment.release();
      if (err instanceof UpstreamError && err.kind === 'no-private-provider') {
        return error(format, 503, `no provider for ${req.model} currently meets the no-retention policy; you were not charged`);
      }
      if (err instanceof UpstreamError && err.kind === 'rejected') return error(format, 400, `the upstream rejected the request (${err.status}); you were not charged`);
      return error(format, 502, 'the upstream is unavailable; you were not charged');
    }

    let tx: string;
    try {
      tx = await payment.settle();
    } catch {
      await upstream.body?.cancel().catch(() => {});
      return error(format, 402, 'payment could not be settled');
    }

    const headers = new Headers({
      'content-type': upstream.headers.get('content-type') ?? (req.stream ? 'text/event-stream' : 'application/json'),
      'cache-control': 'no-store',
      'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: tx, network: config.network, payer: payment.from })).toString('base64'),
    });
    if (req.stream && upstream.body) return new Response(digestingStream(upstream.body), { status: 200, headers });

    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = new Uint8Array(await upstream.arrayBuffer());
    } catch {
      return error(format, 502, 'the upstream response broke off after payment');
    }
    headers.set(DIGEST_HEADER, deliveryDigest(bytes));
    return new Response(bytes, { status: 200, headers });
  }

  return app;
}
