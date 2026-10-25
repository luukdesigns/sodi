/**
 * A stand-in for OpenRouter: the endpoints the gateway uses, with fixed answers, recording what it
 * was sent so tests can check exactly what left the gateway.
 */
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Received {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Record<string, unknown>;
}

export interface MockOpenRouter {
  url: string;
  server: Server;
  received: Received[];
  /** Models that only have providers that keep prompts: a data_collection "deny" request gets 404. */
  retainingOnly: Set<string>;
  credits: { total_credits: number; total_usage: number };
  close(): Promise<void>;
}

export const MODELS = [
  // USD per token, as OpenRouter lists them
  { id: 'test/small', pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 32_000, top_provider: { max_completion_tokens: 4096 } },
  { id: 'test/large', pricing: { prompt: '0.000003', completion: '0.000015', request: '0.0001' }, context_length: 200_000, top_provider: { max_completion_tokens: 8192 } },
  { id: 'test/retaining', pricing: { prompt: '0.000001', completion: '0.000001' }, context_length: 8_000, top_provider: { max_completion_tokens: 2048 } },
  { id: 'meta-llama/llama-guard-4-12b', pricing: { prompt: '0.0000002', completion: '0.0000002' }, context_length: 16_000, top_provider: {} },
  { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' }, context_length: 2_000_000, top_provider: {} },
  // Cheap with a long context: what Claude Code's large system prompt and tool list need.
  { id: 'test/long', pricing: { prompt: '0.0000001', completion: '0.000001' }, context_length: 1_000_000, top_provider: { max_completion_tokens: 8192 } },
  { id: 'test/spread', pricing: { prompt: '0.00000002', completion: '0.0000001' }, context_length: 1_000_000, top_provider: { max_completion_tokens: 8192 } },
  { id: 'test/not-allowlisted', pricing: { prompt: '0', completion: '0' }, context_length: 8_000, top_provider: {} },
];

/** test/spread's providers, cheapest first by a 4:1 input/output mix. */
export const SPREAD = [
  { prompt: '0.00000002', completion: '0.0000001' },
  { prompt: '0.00000003', completion: '0.00000012' },
  { prompt: '0.00000005', completion: '0.0000002' },
  { prompt: '0.0000001', completion: '0.0000004' },
  { prompt: '0.00000015', completion: '0.0000005' },
  { prompt: '0.0000006', completion: '0.0000024' },
];

export const API_KEY = 'sk-or-test-inference';
export const MANAGEMENT_KEY = 'sk-or-test-management';

/** The reply the mock gives: deterministic, so tests can predict the bytes. */
export const answerFor = (body: Record<string, unknown>) => `mock answer from ${String(body.model)} (${String(body.max_tokens)} max)`;

function promptOf(body: Record<string, unknown>): string {
  const msgs = (body.messages ?? []) as { content?: unknown }[];
  return msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
}

export async function startMockOpenRouter(): Promise<MockOpenRouter> {
  const received: Received[] = [];
  const retainingOnly = new Set(['test/retaining']);
  const credits = { total_credits: 100, total_usage: 10 };

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const path = (req.url ?? '/').replace(/^\/api\/v1/, '');
    const r: Received = { method: req.method ?? 'GET', path, headers: { ...req.headers } };
    if (text) r.body = JSON.parse(text);
    received.push(r);
    const auth = req.headers.authorization;
    const json = (status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));

    if (req.method === 'GET' && path === '/models') return json(200, { data: MODELS });
    const endpoints = path.match(/^\/models\/(.+)\/endpoints$/);
    if (req.method === 'GET' && endpoints) {
      const m = MODELS.find((x) => x.id === endpoints[1]);
      if (!m) return json(404, { error: { message: 'no such model' } });
      // One provider at the listed price, except test/spread, whose providers range 1x to 30x.
      const prices = m.id === 'test/spread' ? SPREAD : [m.pricing];
      return json(200, { data: { id: m.id, endpoints: prices.map((pricing, i) => ({ provider_name: `p${i}`, pricing, status: 0 })) } });
    }
    if (req.method === 'GET' && path === '/credits') {
      if (auth !== `Bearer ${MANAGEMENT_KEY}`) return json(403, { error: { message: 'Only management keys can perform this operation' } });
      return json(200, { data: credits });
    }
    if (req.method !== 'POST' || (path !== '/chat/completions' && path !== '/messages')) return json(404, { error: { message: 'not found' } });
    if (auth !== `Bearer ${API_KEY}`) return json(401, { error: { message: 'bad key' } });

    const body = r.body!;
    const provider = body.provider as { data_collection?: string } | undefined;
    // Like OpenRouter, an error that quotes the request: the gateway must never pass it on or log it.
    if (provider?.data_collection !== 'deny') return json(400, { error: { message: `refusing in tests: request without data_collection deny: ${promptOf(body)}` } });
    if (retainingOnly.has(String(body.model))) {
      return json(404, { error: { message: `No endpoints found matching your data policy (Paid model training). Prompt was: ${promptOf(body)}`, code: 404 } });
    }

    if (body.model === 'meta-llama/llama-guard-4-12b') {
      const verdict = promptOf(body).includes('BLOCKME') ? 'unsafe\nS2' : 'safe';
      return json(200, { id: 'gen-guard', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: verdict }, finish_reason: 'stop' }] });
    }

    const answer = answerFor(body);
    const words = answer.split(' ').map((w, i, all) => (i < all.length - 1 ? `${w} ` : w));
    if (path === '/chat/completions') {
      if (!body.stream) {
        return json(200, {
          id: 'gen-1',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: words.length, total_tokens: 10 + words.length },
        });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': OPENROUTER PROCESSING\n\n');
      for (const w of words) {
        res.write(`data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: w } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 5));
      }
      res.write(`data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }

    // Anthropic Messages
    if (!body.stream) {
      return json(200, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: answer }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: words.length },
      });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (const w of words) {
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } });
      await new Promise((r) => setTimeout(r, 5));
    }
    ev('content_block_stop', { type: 'content_block_stop', index: 0 });
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: words.length } });
    ev('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    server,
    received,
    retainingOnly,
    credits,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
