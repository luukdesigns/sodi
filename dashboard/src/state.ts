/**
 * Everything the dashboard shows, built from the agent's local store, its controls file, the chain
 * and (optionally) the approval service. Private keys in the store never leave this module.
 */
import type { ControlSource, Controls, Store } from '@sodi/rx402';
import type { Address, Hex } from 'viem';

export interface DashboardSources {
  store: Store;
  controls: ControlSource;
  /** USDG balance of an address on-chain (sessions spend from these). */
  balanceOf: (address: Address) => Promise<bigint>;
  /** Approval status of a deposit label, from the approval service; omit if unavailable. */
  approvalOf?: (label: string) => Promise<string | undefined>;
  chainId: number;
  asset: Address;
  explorer?: string;
  now?: () => number;
}

export interface DashboardState {
  generatedAt: number;
  chainId: number;
  asset: Address;
  explorer: string | null;
  controls: Controls;
  pool: {
    balance: string;
    deposits: { depositTx: Hex; remaining: string; withdrawals: number; approval: string | null }[];
  };
  sessions: {
    address: Address;
    budget: string;
    spent: string;
    payments: number;
    openedAt: number;
    fundingTx: Hex;
    balance: string | null;
    current: boolean;
  }[];
  totals: {
    spentLast24h: string;
    spentAllTime: string;
    payments: number;
    stealthPayments: number;
    heldInSessions: string;
  };
  payments: { at: number; resource: string; amount: string; payTo: Address; stealth: boolean; session: Address; status?: string }[];
}

const MAX_PAYMENTS_SHOWN = 500;

export async function buildState(src: DashboardSources): Promise<DashboardState> {
  const now = src.now?.() ?? Math.floor(Date.now() / 1000);
  const state = src.store.load();
  const payments = state.payments ?? [];
  const sum = (xs: { amount: string }[]) => xs.reduce((a, p) => a + BigInt(p.amount), 0n);

  const balances = await Promise.all(
    state.sessions.map((s) => src.balanceOf(s.address).then((b) => b, () => null)),
  );
  const approvals = await Promise.all(
    state.notes.map((n) => (src.approvalOf ? src.approvalOf(n.label).then((a) => a ?? null, () => null) : Promise.resolve(null))),
  );

  return {
    generatedAt: now,
    chainId: src.chainId,
    asset: src.asset,
    explorer: src.explorer ?? null,
    controls: src.controls.load(),
    pool: {
      balance: state.notes.reduce((a, n) => a + BigInt(n.value), 0n).toString(),
      deposits: state.notes.map((n, i) => ({
        depositTx: n.depositTx,
        remaining: n.value,
        withdrawals: n.spendCount,
        approval: approvals[i] ?? null,
      })),
    },
    sessions: state.sessions
      .map((s, i) => ({
        address: s.address,
        budget: s.budget,
        spent: s.spent,
        payments: s.payments,
        openedAt: s.openedAt,
        fundingTx: s.fundingTx,
        balance: balances[i]?.toString() ?? null,
        current: i === state.sessions.length - 1,
      }))
      .reverse(),
    totals: {
      spentLast24h: sum(payments.filter((p) => p.at >= now - 86_400)).toString(),
      spentAllTime: sum(payments).toString(),
      payments: payments.length,
      stealthPayments: payments.filter((p) => p.stealth).length,
      heldInSessions: balances.reduce<bigint>((a, b) => a + (b ?? 0n), 0n).toString(),
    },
    payments: payments.slice(-MAX_PAYMENTS_SHOWN).reverse(),
  };
}

/** Validates a controls update from the UI. Amounts are base-unit integer strings. */
export function parseControls(body: unknown): Controls {
  if (typeof body !== 'object' || body === null) throw new Error('expected an object');
  const b = body as Record<string, unknown>;
  if (typeof b.paused !== 'boolean') throw new Error('paused must be true or false');
  const amount = (k: string) => {
    const v = b[k];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || !/^\d{1,30}$/.test(v)) throw new Error(`${k} must be a whole number of base units`);
    return v;
  };
  let allowedHosts: string[] | undefined;
  if (b.allowedHosts !== undefined && b.allowedHosts !== null) {
    if (!Array.isArray(b.allowedHosts) || b.allowedHosts.some((h) => typeof h !== 'string' || !/^[a-z0-9.-]+(:\d+)?$/i.test(h))) {
      throw new Error('allowedHosts must be a list of host names');
    }
    allowedHosts = (b.allowedHosts as string[]).map((h) => h.toLowerCase());
  }
  const c: Controls = { paused: b.paused };
  const maxPaymentAmount = amount('maxPaymentAmount');
  const dailyLimit = amount('dailyLimit');
  if (maxPaymentAmount !== undefined) c.maxPaymentAmount = maxPaymentAmount;
  if (dailyLimit !== undefined) c.dailyLimit = dailyLimit;
  if (allowedHosts?.length) c.allowedHosts = allowedHosts;
  return c;
}
