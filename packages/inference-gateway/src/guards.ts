/**
 * What keeps the upstream key alive: a per-payer rate limit, and an abuse hook that sees the prompt
 * before it is forwarded. Both refuse before payment is settled, so a refused request costs nothing.
 */
import type { InferenceRequest } from './requests.js';
import type { Upstream } from './upstream.js';

/** Sliding-window limit per paying address (an rx402 session). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now = () => Date.now(),
  ) {}

  /** Records a request and says whether it is within the limit. */
  take(key: string): boolean {
    const t = this.now();
    const k = key.toLowerCase();
    const recent = (this.hits.get(k) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(k, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(k, recent);
    if (this.hits.size > 10_000) this.sweep(t);
    return true;
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
  }
}

export type AbuseVerdict = { allow: true } | { allow: false; reason: string };

/**
 * Runs on every paid request before it goes upstream. Gets the request and its prompt text. Must not
 * log or store either: the gateway's no-logging promise covers hooks too.
 */
export interface AbuseHook {
  check(input: { request: InferenceRequest; prompt: string }): Promise<AbuseVerdict>;
}

/** The default: lets everything through. */
export const allowAll: AbuseHook = { check: async () => ({ allow: true }) };

/**
 * Example classifier: asks a guard model (Llama Guard by default) through the same upstream, under
 * the same no-retention routing, whether the prompt is safe. The guard's answer starts with "safe"
 * or "unsafe" followed by the violated categories.
 *
 * It costs one small upstream call per request, paid by the operator, and it sends the prompt to a
 * second provider. Shipped as an example of the interface; an operator who wants it turns it on.
 */
export class GuardModelClassifier implements AbuseHook {
  constructor(
    private readonly upstream: Upstream,
    private readonly model = 'meta-llama/llama-guard-4-12b',
    /** Categories to refuse; default all. Llama Guard 4 codes, e.g. ["S1", "S4"]. */
    private readonly categories?: string[],
  ) {}

  async check({ prompt }: { prompt: string }): Promise<AbuseVerdict> {
    let res: Response;
    try {
      res = await this.upstream.send('/chat/completions', { model: this.model, messages: [{ role: 'user', content: prompt }], max_tokens: 20 });
    } catch {
      return { allow: false, reason: 'the safety check is unavailable' }; // fail closed
    }
    const body = (await res.json().catch(() => undefined)) as { choices?: { message?: { content?: string } }[] } | undefined;
    const verdict = (body?.choices?.[0]?.message?.content ?? '').trim();
    if (/^safe\b/i.test(verdict)) return { allow: true };
    if (!/^unsafe\b/i.test(verdict)) return { allow: false, reason: 'the safety check gave no verdict' };
    const flagged = verdict.match(/S\d+/g) ?? [];
    if (this.categories && flagged.length && !flagged.some((c) => this.categories!.includes(c))) return { allow: true };
    return { allow: false, reason: `refused by the safety check${flagged.length ? ` (${flagged.join(', ')})` : ''}` };
  }
}
