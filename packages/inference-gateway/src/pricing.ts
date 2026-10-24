/**
 * The price of a request, fixed before anything is sent upstream.
 *
 *   price = (input tokens × prompt price + max_tokens × completion price + per-request price) × (1 + margin)
 *
 * Input tokens are estimated without a tokenizer, from the size of the prompt: one token per three
 * bytes of UTF-8, plus a little per message. Real tokenizers average closer to four bytes a token on
 * English text, so the estimate runs high, and the output side assumes every one of max_tokens is
 * used. Both errors are on the side of overcharging, and whatever the request doesn't use is margin.
 */
import { parseUnits } from 'viem';

import type { InferenceRequest } from './requests.js';
import type { ModelInfo } from './upstream.js';

const BYTES_PER_TOKEN = 3;
const TOKENS_PER_MESSAGE = 8;
const TOKENS_PER_REQUEST = 16;
/** atto-USD (1e-18) per USDG base unit (1e-6). */
const ATTO_PER_UNIT = 10n ** 12n;

export interface Quote {
  /** USDG base units (6 decimals). */
  amount: bigint;
  inputTokens: number;
  maxOutputTokens: number;
}

export class PricingError extends Error {}

export function estimateInputTokens(req: InferenceRequest): number {
  const priced = ['system', 'messages', 'tools', 'tool_choice', 'response_format'].map((k) => req.body[k]).filter((v) => v !== undefined);
  const bytes = Buffer.byteLength(JSON.stringify(priced), 'utf8');
  return Math.ceil(bytes / BYTES_PER_TOKEN) + TOKENS_PER_MESSAGE * (req.body.messages as unknown[]).length + TOKENS_PER_REQUEST;
}

const atto = (usd: string | undefined, what: string): bigint => {
  if (usd === undefined || usd === '') return 0n;
  let v: bigint;
  try {
    v = parseUnits(usd, 18);
  } catch {
    throw new PricingError(`unreadable ${what} price`);
  }
  // OpenRouter lists routers with variable prices as -1: those can't be quoted up front.
  if (v < 0n) throw new PricingError(`${what} price is variable`);
  return v;
};

export function quote(req: InferenceRequest, model: ModelInfo, marginBps: number): Quote {
  const inputTokens = estimateInputTokens(req);
  if (model.contextLength && inputTokens + req.maxTokens > model.contextLength) {
    throw new PricingError(`prompt plus max_tokens is over the model's ${model.contextLength}-token context`);
  }
  if (model.maxCompletionTokens && req.maxTokens > model.maxCompletionTokens) {
    throw new PricingError(`max_tokens is over the model's limit of ${model.maxCompletionTokens}`);
  }
  const cost =
    BigInt(inputTokens) * atto(model.pricing.prompt, 'prompt') +
    BigInt(req.maxTokens) * atto(model.pricing.completion, 'completion') +
    atto(model.pricing.request, 'request');
  const withMargin = (cost * BigInt(10_000 + marginBps) + 9_999n) / 10_000n;
  const amount = (withMargin + ATTO_PER_UNIT - 1n) / ATTO_PER_UNIT;
  return { amount: amount > 0n ? amount : 1n, inputTokens, maxOutputTokens: req.maxTokens };
}
