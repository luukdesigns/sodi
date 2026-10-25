/**
 * A local paying proxy: lets Claude Code (or any Anthropic-format client) use a Sodi inference
 * gateway with no API key and no account. Point the client at it:
 *
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:8411 ANTHROPIC_API_KEY=unused claude
 *
 * Each request is forwarded to the gateway; the gateway's 402 is paid from an rx402 session (a fresh
 * address with no history), and the answer is streamed back unchanged. The client's API key and
 * headers never leave this machine.
 *
 * Listens on 127.0.0.1 only: anything that can reach the port can spend from the wallet.
 */
import { createHash } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { Readable } from 'node:stream';

import type { Rx402Client } from '@sodi/rx402';
import { formatUnits } from 'viem';
import { inspectQuoteText } from 'wormhole-x402/quotetext';

const STREAM_DIGEST_PREFIX = ': sodi-delivery-digest ';

export interface ProxyOptions {
  /** The inference gateway, e.g. https://inference.sodi.network */
  gatewayUrl: string;
  /** Used for requests naming a model the gateway doesn't serve, such as Claude Code's `claude-*` defaults. */
  defaultModel: string;
  /** max_tokens above this is lowered to it (Claude Code asks for more than gateways allow). */
  maxTokens: number;
  /** Total this proxy may spend while it runs (USDG base units). */
  maxTotalSpend: bigint;
  /** Called once per request with what was paid; never with the prompt. */
  log?: (line: string) => void;
}

const usd = (v: bigint) => formatUnits(v, 6);
const sha256 = (s: string) => `sha256=${createHash('sha256').update(s).digest('hex')}`;

/** The gateway's receipt: a header for whole bodies, a final SSE comment for streams. Undefined if there is none. */
export function checkDigest(body: string, header?: string): boolean | undefined {
  if (header) return sha256(body) === header;
  const at = body.lastIndexOf(STREAM_DIGEST_PREFIX);
  if (at < 0) return undefined;
  return sha256(body.slice(0, at)) === body.slice(at + STREAM_DIGEST_PREFIX.length).trim();
}

function anthropicError(res: ServerResponse, status: number, type: string, message: string) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type, message } }));
}

async function readBody(req: IncomingMessage, limit = 8_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Rough token count for count_tokens, the same estimate the gateway prices with (it runs high). */
function estimateTokens(body: Record<string, unknown>): number {
  const priced = ['system', 'messages', 'tools', 'tool_choice'].map((k) => body[k]).filter((v) => v !== undefined);
  return Math.ceil(Buffer.byteLength(JSON.stringify(priced)) / 3) + 8 * ((body.messages as unknown[] | undefined)?.length ?? 0) + 16;
}

export interface PaidProxy {
  server: Server;
  /** What the proxy has paid so far. */
  spent(): bigint;
}

export function createPaidProxy(client: Rx402Client, options: ProxyOptions): PaidProxy {
  const gateway = new URL(options.gatewayUrl);
  let spent = 0n;
  let served: Set<string> | undefined;

  // Which models the gateway serves, fetched once (free: GET /v1/models needs no payment).
  async function servedModels(): Promise<Set<string>> {
    if (served) return served;
    try {
      const res = await fetch(new URL('/v1/models', gateway));
      const { data } = (await res.json()) as { data: { id: string }[] };
      served = new Set(data.map((m) => m.id));
    } catch {
      return new Set();
    }
    return served;
  }

  async function messages(req: IncomingMessage, res: ServerResponse) {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return anthropicError(res, 400, 'invalid_request_error', 'body is not valid JSON');
    }

    const asked = String(body.model ?? '');
    const model = (await servedModels()).has(asked) ? asked : options.defaultModel;
    body.model = model;
    if (typeof body.max_tokens !== 'number' || body.max_tokens > options.maxTokens) body.max_tokens = options.maxTokens;
    // Claude Code puts some context in messages with role "system", which only Claude's own API
    // accepts: move that text into the system prompt.
    if (Array.isArray(body.messages)) {
      const moved: unknown[] = [];
      body.messages = (body.messages as { role?: string; content?: unknown }[]).filter((m) => {
        if (m?.role !== 'system') return true;
        if (typeof m.content === 'string') moved.push({ type: 'text', text: m.content });
        else if (Array.isArray(m.content)) moved.push(...m.content);
        return false;
      });
      if (moved.length) {
        const system = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : Array.isArray(body.system) ? body.system : [];
        body.system = [...system, ...moved];
      }
    }
    const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined;
    // Claude Code asks for Claude-only thinking modes ("adaptive"); other models use their own default.
    if (thinking && thinking.type !== 'enabled') delete body.thinking;
    if (thinking?.type === 'enabled' && typeof thinking.budget_tokens === 'number' && thinking.budget_tokens >= (body.max_tokens as number)) {
      thinking.budget_tokens = Math.max(1024, Math.floor((body.max_tokens as number) / 2));
      if (thinking.budget_tokens >= (body.max_tokens as number)) delete body.thinking;
    }

    const remaining = options.maxTotalSpend - spent;
    if (remaining <= 0n) return anthropicError(res, 402, 'payment_required', `the proxy's spending limit (${usd(options.maxTotalSpend)} USDG) has been reached`);

    let paid;
    try {
      paid = await client.fetch(
        new URL('/v1/messages', gateway),
        // Only the body and its type go to the gateway: not the client's API key, not its headers.
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
        {
          maxPaymentAmount: remaining,
          allowedHosts: [gateway.host],
          inspect: (quote) => {
            const verdict = inspectQuoteText(quote);
            if (verdict.decision !== 'allow') throw new Error(`refused the gateway's quote: it failed the quote-text scan (${verdict.findings.map((f) => f.code).join(', ') || verdict.reason})`);
          },
        },
      );
    } catch (err) {
      const signed = (err as { payment?: { amount: bigint } }).payment;
      if (signed) spent += signed.amount;
      options.log?.(`${model}: not paid: ${(err as Error).message}`);
      return anthropicError(res, 402, 'payment_required', (err as Error).message);
    }
    const { response, payment } = paid;
    if (payment) spent += payment.amount;

    const headers: Record<string, string> = { 'content-type': response.headers.get('content-type') ?? 'application/json' };
    for (const h of ['sodi-delivery-digest', 'payment-response']) {
      const v = response.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(response.status, headers);
    if (!response.body) return void res.end();

    // Pass the bytes through as they arrive, and keep them to check the gateway's delivery digest.
    const chunks: Buffer[] = [];
    const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
    stream.on('data', (chunk: Buffer) => {
      res.write(chunk);
      chunks.push(chunk);
    });
    stream.on('error', () => res.destroy());
    stream.on('end', () => {
      res.end();
      const delivered = Buffer.concat(chunks).toString('utf8');
      const ok = checkDigest(delivered, headers['sodi-delivery-digest']);
      options.log?.(
        `${model}: ${response.status}, paid ${payment ? usd(payment.amount) : '0'} USDG from ${payment?.from ?? '-'}, ` +
          `delivery ${ok === undefined ? 'unreceipted' : ok ? 'verified' : 'DIGEST MISMATCH'}, ${usd(spent)} of ${usd(options.maxTotalSpend)} USDG spent`,
      );
    });
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const run = async () => {
      if (req.method === 'POST' && path === '/v1/messages') return messages(req, res);
      // Answered locally, for free: Claude Code calls this to size its context.
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        try {
          return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: estimateTokens(JSON.parse(await readBody(req))) }));
        } catch {
          return anthropicError(res, 400, 'invalid_request_error', 'body is not valid JSON');
        }
      }
      if (req.method === 'GET' && path === '/v1/models') {
        const ids = [...(await servedModels())];
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: ids.map((id) => ({ type: 'model', id, display_name: id })), has_more: false }));
      }
      anthropicError(res, 404, 'not_found_error', `${req.method} ${path} is not served by the rx402 proxy`);
    };
    run().catch(() => (res.headersSent ? res.destroy() : anthropicError(res, 500, 'api_error', 'proxy error')));
  });
  return { server, spent: () => spent };
}
