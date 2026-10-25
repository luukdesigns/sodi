/**
 * Turns a client's request body into the one we forward: only fields we know how to price are kept,
 * and max_tokens is always set, so the price quoted before the call is an upper bound on its cost.
 */

export type Format = 'openai' | 'anthropic';

export interface InferenceRequest {
  format: Format;
  model: string;
  /** Enforced upstream; the price assumes every one of them is used. */
  maxTokens: number;
  stream: boolean;
  /** The body sent upstream (routing policy added at send time). */
  body: Record<string, unknown>;
}

export class RequestError extends Error {}

/**
 * Fields forwarded as they are. Anything else is dropped: fields that would let a request cost more
 * than its quote (`n`, `models` fallbacks, web-search `plugins`, reasoning budgets outside max_tokens),
 * fields that identify the caller (`user`, `metadata`, `session_id`), and our own `provider`.
 */
const OPENAI_FIELDS = [
  'messages',
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'top_a',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'seed',
  'stop',
  'response_format',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'logit_bias',
  'logprobs',
  'top_logprobs',
] as const;

const ANTHROPIC_FIELDS = ['messages', 'system', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'tools', 'tool_choice', 'thinking'] as const;

export interface Limits {
  /** Used when the client doesn't set max_tokens. */
  defaultMaxTokens: number;
  /** Requests asking for more are refused, not silently cut. */
  maxTokens: number;
}

const positiveInt = (v: unknown, name: string): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new RequestError(`${name} must be a positive integer`);
  return v;
};

export function parseRequest(format: Format, raw: unknown, limits: Limits): InferenceRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RequestError('body must be a JSON object');
  const b = raw as Record<string, unknown>;
  if (typeof b.model !== 'string' || !b.model) throw new RequestError('model is required');
  if (!Array.isArray(b.messages) || b.messages.length === 0) throw new RequestError('messages must be a non-empty array');
  if (b.stream !== undefined && typeof b.stream !== 'boolean') throw new RequestError('stream must be a boolean');
  if (b.n !== undefined && b.n !== 1) throw new RequestError('n must be 1');

  // OpenAI has two names for the same cap; take the stricter.
  const asked = [positiveInt(b.max_tokens, 'max_tokens'), format === 'openai' ? positiveInt(b.max_completion_tokens, 'max_completion_tokens') : undefined].filter(
    (x): x is number => x !== undefined,
  );
  const maxTokens = asked.length ? Math.min(...asked) : limits.defaultMaxTokens;
  if (maxTokens > limits.maxTokens) throw new RequestError(`max_tokens is at most ${limits.maxTokens} here`);

  const body: Record<string, unknown> = { model: b.model };
  for (const f of format === 'openai' ? OPENAI_FIELDS : ANTHROPIC_FIELDS) if (b[f] !== undefined) body[f] = b[f];
  body.max_tokens = maxTokens;
  const stream = b.stream === true;
  if (stream) body.stream = true;

  if (format === 'anthropic' && (b.messages as { role?: unknown }[]).some((m) => m?.role !== 'user' && m?.role !== 'assistant')) {
    throw new RequestError('messages may only have the roles "user" and "assistant"; put system text in "system"');
  }
  if (format === 'anthropic' && body.thinking !== undefined) {
    // Extended thinking is billed as output; Anthropic requires its budget to sit inside max_tokens.
    const t = body.thinking as { type?: string; budget_tokens?: unknown };
    // Only the two portable forms: other modes (Claude's "adaptive", say) aren't understood by other
    // models' providers, and the upstream would reject the request.
    if (t?.type !== 'enabled' && t?.type !== 'disabled') throw new RequestError('thinking.type must be "enabled" (with budget_tokens) or "disabled"');
    if (t?.type === 'enabled' && !(typeof t.budget_tokens === 'number' && t.budget_tokens < maxTokens)) {
      throw new RequestError('thinking.budget_tokens must be below max_tokens');
    }
  }
  return { format, model: b.model, maxTokens, stream, body };
}

/** All prompt text, for the abuse hook: system prompt, then every text part of every message. */
export function promptText(req: InferenceRequest): string {
  const out: string[] = [];
  const take = (c: unknown) => {
    if (typeof c === 'string') out.push(c);
    else if (Array.isArray(c)) for (const p of c) if (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string') out.push((p as { text: string }).text);
  };
  take(req.body.system);
  for (const m of req.body.messages as { content?: unknown }[]) take(m?.content);
  return out.join('\n');
}
