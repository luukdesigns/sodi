import type { ModelInfo, Upstream } from './upstream.js';

/**
 * The allowlisted models with their current upstream prices, refreshed every `ttlMs`. A model the
 * upstream stops listing, or lists without fixed prices, is unavailable until it comes back.
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
  ) {
    if (!allowlist.length) throw new Error('the model allowlist is empty');
  }

  private async refresh(): Promise<void> {
    const listed = await this.upstream.models();
    const allowed = new Set(this.allowlist);
    this.models = new Map(listed.filter((m) => allowed.has(m.id)).map((m) => [m.id, m]));
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
