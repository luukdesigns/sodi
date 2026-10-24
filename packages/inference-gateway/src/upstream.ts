/**
 * The upstream: OpenRouter, or anything that speaks its API (a mock in tests).
 *
 * Every request is built here from scratch. Nothing from the client's request reaches it except the
 * sanitized body: no headers, no IP, no user agent. The only headers sent are our key and the
 * content type.
 */

export interface ModelInfo {
  id: string;
  /** USD per token, as OpenRouter publishes them (decimal strings). */
  pricing: { prompt: string; completion: string; request?: string };
  contextLength?: number;
  maxCompletionTokens?: number;
}

/** What we tell the upstream about routing, on every request. */
export interface RoutingPolicy {
  /** "deny": only providers that don't store or train on prompts. Always "deny" in this gateway. */
  data_collection: 'deny';
  /** Also require zero-data-retention endpoints. Off by default; stricter than data_collection. */
  zdr?: boolean;
  /** Providers must support every parameter we send, max_tokens included, so the cap is real. */
  require_parameters: true;
}

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly kind: 'no-private-provider' | 'rejected' | 'unavailable',
  ) {
    super(`upstream ${kind} (${status})`);
  }
}

export interface UpstreamConfig {
  /** e.g. https://openrouter.ai/api/v1 */
  baseUrl: string;
  /** Inference key. */
  apiKey: string;
  /** Management key, for the credit balance. Optional: without it the keeper can't run. */
  managementKey?: string;
  zdr?: boolean;
  fetch?: typeof fetch;
}

/**
 * OpenRouter answers 404 "No endpoints found matching your data policy" (or similar) when routing
 * constraints leave no provider. We read only the status and a fixed phrase from the error body, and
 * never pass the body on: an upstream error can quote the request.
 */
const NO_PROVIDER = /no (allowed )?(endpoints|providers)/i;

export class Upstream {
  private readonly f: typeof fetch;

  constructor(private readonly config: UpstreamConfig) {
    this.f = config.fetch ?? fetch;
  }

  get routing(): RoutingPolicy {
    return { data_collection: 'deny', require_parameters: true, ...(this.config.zdr ? { zdr: true } : {}) };
  }

  async models(): Promise<ModelInfo[]> {
    const res = await this.f(`${this.config.baseUrl}/models`, { headers: { authorization: `Bearer ${this.config.apiKey}` } });
    if (!res.ok) throw new UpstreamError(res.status, 'unavailable');
    const { data } = (await res.json()) as {
      data: { id: string; pricing?: Record<string, string>; context_length?: number; top_provider?: { max_completion_tokens?: number | null } }[];
    };
    return data
      .filter((m) => m.pricing?.prompt !== undefined && m.pricing?.completion !== undefined)
      .map((m) => ({
        id: m.id,
        pricing: { prompt: m.pricing!.prompt!, completion: m.pricing!.completion!, request: m.pricing!.request },
        contextLength: m.context_length,
        maxCompletionTokens: m.top_provider?.max_completion_tokens ?? undefined,
      }));
  }

  /** Remaining credit in USD. Needs the management key. */
  async remainingCredits(): Promise<number> {
    if (!this.config.managementKey) throw new Error('no management key: credit balance unavailable');
    const res = await this.f(`${this.config.baseUrl}/credits`, { headers: { authorization: `Bearer ${this.config.managementKey}` } });
    if (!res.ok) throw new UpstreamError(res.status, 'unavailable');
    const { data } = (await res.json()) as { data: { total_credits: number; total_usage: number } };
    return data.total_credits - data.total_usage;
  }

  /**
   * Sends a sanitized body to `/chat/completions` or `/messages` with our routing policy. Resolves
   * once the upstream has accepted the request (status and headers received); the body is still
   * unread, so the caller can settle payment before streaming it on.
   */
  async send(path: '/chat/completions' | '/messages', body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const res = await this.f(`${this.config.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, provider: this.routing }),
      signal,
    });
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    await res.body?.cancel().catch(() => {});
    if ((res.status === 404 || res.status === 400) && NO_PROVIDER.test(text)) throw new UpstreamError(res.status, 'no-private-provider');
    throw new UpstreamError(res.status, res.status >= 500 || res.status === 429 || res.status === 402 ? 'unavailable' : 'rejected');
  }
}
