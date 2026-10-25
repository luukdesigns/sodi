/**
 * Sweeping gateway revenue, with the margin share paid to a fee sink.
 *
 * Revenue arrives at one-time stealth addresses that only the operator's spending key can move (the
 * gateway itself holds the viewing key only), so the share is paid when the operator sweeps: each
 * payment's balance is split, the sink's part sent first.
 *
 * A request is charged its upstream cost plus `marginBps`, so the margin is `marginBps / (10_000 +
 * marginBps)` of revenue. A share of the margin is that times the share. Overpayment the gateway keeps
 * as session credit is spent on later requests, so revenue tracks charges and the split stays right
 * over time.
 */
import type { FoundPayment, StealthMerchant, TokenDomain } from '@sodi/stealth';
import type { Address, PublicClient, WalletClient } from 'viem';

/** The part of revenue, in basis points, that is `shareOfMarginBps` of the margin. */
export function marginShareOfRevenueBps(shareOfMarginBps: number, marginBps: number): number {
  if (shareOfMarginBps < 0 || shareOfMarginBps > 10_000 || marginBps < 0) throw new Error('bad share or margin');
  return Math.floor((shareOfMarginBps * marginBps) / (10_000 + marginBps));
}

export interface SweepConfig {
  merchant: StealthMerchant;
  publicClient: PublicClient;
  gasPayer: WalletClient;
  payments: FoundPayment[];
  token: Address;
  domain: TokenDomain;
  /** Where the operator's part goes (ideally a privacy pool deposit, not one public address). */
  to: Address;
  /** The fee sink; unset or zero, nothing is split off. */
  feeSink?: Address;
  shareOfMarginBps: number;
  marginBps: number;
}

export function sweepRevenue(c: SweepConfig) {
  const sink = c.feeSink && c.feeSink !== '0x0000000000000000000000000000000000000000' ? c.feeSink : undefined;
  const bps = sink ? marginShareOfRevenueBps(c.shareOfMarginBps, c.marginBps) : 0;
  return c.merchant.sweep({
    publicClient: c.publicClient,
    gasPayer: c.gasPayer,
    payments: c.payments,
    token: c.token,
    domain: c.domain,
    to: c.to,
    ...(sink && bps > 0 ? { split: { to: sink, bps } } : {}),
  });
}
