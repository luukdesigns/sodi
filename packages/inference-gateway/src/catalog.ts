import { parseUnits } from 'viem';

import type { ModelInfo, Pricing, Upstream } from './upstream.js';

/**
 * A model's price ceiling: the most expensive of its `n` cheapest providers, per price component.
 * A model's providers can differ in price many times over, and the one OpenRouter routes to isn't
 * known in advance, so requests are quoted at this ceiling and routed with it as `max_price`: the
 * quote is then an upper bound on what the upstream can charge. With `sort: price` the cheapest
 * qualifying provider is used, and the difference is margin.
 */
export function priceCeiling(providers: Pricing[], n: number): Pricing | undefined {
  if (!providers.length) return undefined;
  const v = (s?: string) => (s ? parseUnits(s, 18) : 0n);
  // Rank by the cost of a typical request shape: 4 input tokens per output token.
  const cheapest = [...providers].sort((a, b) => {
    const d = 4n * v(a.prompt) + v(a.completion) - (4n * v(b.prompt) + v(b.completion));
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }).slice(0, Math.max(1, n));
  const max = (k: 'prompt' | 'completion' | 'request') => cheapest.reduce((m, p) => (v(p[k]) > v(m) ? p[k]! : m), '0');
  const request = max('request');
  return { prompt: max('prompt'), completion: max('completion'), ...(request !== '0' ? { request } : {}) };
}

/**
 * The allowlisted models with their price ceilings, refreshed every `ttlMs`. A model the upstream
 * stops listing, or lists without fixed prices, is unavailable until it comes back.
 */
export class ModelCatalog {
  private models = new Map<string, ModelInfo>();
  private fetchedAt = 0;
  private refreshing?: Promise<void>;

  constructor(
    private readonly upstream: Upstream,
    readonly allowlist: string[],
    private readonly ttlMs = 10 * 60_000,
    private readonly now = () => Date.now(),
    /** How many of the cheapest providers the price ceiling admits. */
    private readonly ceilingProviders = 5,
  ) {
    if (!allowlist.length) throw new Error('the model allowlist is empty');
  }

  private async refresh(): Promise<void> {
    const listed = await this.upstream.models();
    const allowed = new Set(this.allowlist);
    const models = new Map<string, ModelInfo>();
    for (const m of listed.filter((x) => allowed.has(x.id))) {
      // Without the provider list, fall back to the listed price: still a hard cap, since requests are
      // routed with the quoted price as max_price; fewer providers may qualify.
      const ceiling = priceCeiling(await this.upstream.endpointPrices(m.id).catch(() => []), this.ceilingProviders);
      models.set(m.id, ceiling ? { ...m, pricing: ceiling } : m);
    }
    this.models = models;
    this.fetchedAt = this.now();
  }

  async get(id: string): Promise<ModelInfo | undefined> {
    if (!this.allowlist.includes(id)) return undefined;
    if (this.now() - this.fetchedAt > this.ttlMs) {
      this.refreshing ??= this.refresh().finally(() => (this.refreshing = undefined));
      // Serve stale prices if a refresh fails; fail only if we never had any.
      await this.refreshing.catch((err) => {
        if (!this.fetchedAt) throw err;
      });
    }
    return this.models.get(id);
  }
}
