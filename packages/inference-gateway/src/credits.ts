/**
 * Change from overpaid requests, kept for the paying address's next request.
 *
 * A request is paid up front at its quote: every allowed output token, at the price ceiling. After
 * the request the upstream reports what it actually cost; the difference (less the margin) is
 * credited to the paying address, an rx402 session, and taken off that session's next quote. Over a
 * session's life an agent pays about the real cost plus margin.
 *
 * The client names its session on the unpaid request (`Sodi-Payer`) to get the reduced quote, and
 * the credit is only applied if the payment then comes from that address: spending a session's
 * credit takes its key. Requests from the same session are already linkable by their payer, so the
 * credit links nothing new. Kept in memory and dropped after `ttlMs`: a restart forfeits it.
 */
export class CreditLedger {
  private readonly credit = new Map<string, { amount: bigint; until: number }>();

  constructor(
    private readonly ttlMs = 24 * 3600_000,
    private readonly now = () => Date.now(),
  ) {}

  available(address: string): bigint {
    const k = address.toLowerCase();
    const c = this.credit.get(k);
    if (!c) return 0n;
    if (c.until < this.now()) {
      this.credit.delete(k);
      return 0n;
    }
    return c.amount;
  }

  /** Takes up to `amount` of the address's credit; returns what was taken and a way to put it back. */
  take(address: string, amount: bigint): { taken: bigint; restore(): void } {
    const k = address.toLowerCase();
    const taken = amount < this.available(k) ? amount : this.available(k);
    if (taken > 0n) this.set(k, this.available(k) - taken);
    let restored = false;
    return {
      taken,
      restore: () => {
        if (restored || taken === 0n) return;
        restored = true;
        this.add(k, taken);
      },
    };
  }

  add(address: string, amount: bigint): void {
    if (amount <= 0n) return;
    const k = address.toLowerCase();
    this.set(k, this.available(k) + amount);
  }

  private set(k: string, amount: bigint) {
    if (amount > 0n) this.credit.set(k, { amount, until: this.now() + this.ttlMs });
    else this.credit.delete(k);
    if (this.credit.size > 50_000) for (const [key, c] of this.credit) if (c.until < this.now()) this.credit.delete(key);
  }
}

/**
 * What the upstream charged, in USD, from OpenRouter's usage accounting (`"usage": {…, "cost": n}`),
 * in a JSON body or an SSE stream. Undefined if it isn't there. Takes the last unescaped `"cost":`
 * key, so text inside the answer (where quotes are escaped) can't be mistaken for it.
 */
export function upstreamCost(body: string): number | undefined {
  let last: number | undefined;
  for (const m of body.matchAll(/(?<!\\)"cost":\s*([0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)/g)) last = Number(m[1]);
  return last !== undefined && Number.isFinite(last) && last >= 0 ? last : undefined;
}
