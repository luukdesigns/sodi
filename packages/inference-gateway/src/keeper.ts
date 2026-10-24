/**
 * Keeps the upstream account funded.
 *
 * Revenue arrives in USDG at stealth addresses; the upstream is paid in credits. The keeper watches
 * the credit balance and, below a threshold, asks a `TopUp` to buy more. Below a lower floor the
 * gateway stops quoting new requests, so no agent pays for a request we couldn't serve.
 *
 * OpenRouter removed its programmatic crypto top-up (POST /api/v1/credits/coinbase returns 410 Gone;
 * credits are bought through its web checkout). Until it offers one again, the shipped TopUp is a
 * webhook that tells the operator to buy credits. Anything that can buy credits plugs in here.
 */

export interface CreditSource {
  /** Remaining upstream credit, in USD. */
  remainingCredits(): Promise<number>;
}

export interface TopUp {
  /** Asked to add about `amountUsd` of credit; `remainingUsd` is what's left now. */
  topUp(amountUsd: number, remainingUsd: number): Promise<void>;
}

/** POSTs { event, remainingUsd, requestedUsd } to an operator webhook. */
export class WebhookTopUp implements TopUp {
  constructor(
    private readonly url: string,
    private readonly f: typeof fetch = fetch,
  ) {}

  async topUp(amountUsd: number, remainingUsd: number): Promise<void> {
    const res = await this.f(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'upstream-credits-low', remainingUsd, requestedUsd: amountUsd }),
    });
    if (!res.ok) throw new Error(`top-up webhook answered ${res.status}`);
  }
}

export interface KeeperConfig {
  source: CreditSource;
  topUp: TopUp;
  /** Top up when the balance falls below this (USD). */
  thresholdUsd: number;
  /** How much to ask for (USD). */
  topUpUsd: number;
  /** Stop quoting new requests below this (USD). */
  floorUsd: number;
  /** Don't ask again within this long of the last request, so a slow top-up isn't repeated every tick. */
  cooldownMs?: number;
  intervalMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}

export interface KeeperState {
  remainingUsd?: number;
  checkedAt?: number;
  lastTopUpAt?: number;
  topUps: number;
}

export class CreditKeeper {
  readonly state: KeeperState = { topUps: 0 };
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly config: KeeperConfig) {}

  private now() {
    return this.config.now?.() ?? Date.now();
  }

  /** False only when the last balance we saw is below the floor. */
  canServe(): boolean {
    return this.state.remainingUsd === undefined || this.state.remainingUsd >= this.config.floorUsd;
  }

  /** One check: read the balance, top up if it's low. */
  async tick(): Promise<void> {
    const remaining = await this.config.source.remainingCredits();
    this.state.remainingUsd = remaining;
    this.state.checkedAt = this.now();
    if (remaining >= this.config.thresholdUsd) return;
    const cooldown = this.config.cooldownMs ?? 15 * 60_000;
    if (this.state.lastTopUpAt !== undefined && this.now() - this.state.lastTopUpAt < cooldown) return;
    this.state.lastTopUpAt = this.now();
    await this.config.topUp.topUp(this.config.topUpUsd, remaining);
    this.state.topUps += 1;
  }

  start(): void {
    const run = () => this.tick().catch((err) => this.config.onError?.(err));
    void run();
    this.timer = setInterval(run, this.config.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
