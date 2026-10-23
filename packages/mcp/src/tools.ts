import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Rx402Client } from '@sodi/rx402';
import { formatUnits, parseUnits } from 'viem';
import { z } from 'zod';

const DECIMALS = 6; // USDG
const MAX_BODY_CHARS = 20_000;

export interface McpOptions {
  /** Total the agent may spend on x402 payments while this server runs (base units). */
  maxTotalSpend: bigint;
  /** Only these hosts may be paid; empty means any. */
  allowedHosts: string[];
}

const usd = (v: bigint) => formatUnits(v, DECIMALS);
const toUnits = (s: string) => {
  const v = parseUnits(s, DECIMALS);
  if (v <= 0n) throw new Error('amount must be positive');
  return v;
};
const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }],
});
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

/**
 * MCP tools over an rx402 client. Payments are capped three ways: the per-request maximum in the
 * rx402 policy, an optional lower cap per call, and a running total for this server process.
 */
export function createSodiMcpServer(client: Rx402Client, options: McpOptions): McpServer {
  const server = new McpServer({ name: 'sodi', version: '0.1.0' });
  let totalSpent = 0n;

  server.registerTool(
    'rx402_status',
    {
      title: 'Private wallet status',
      description:
        'Shows the private USDG balance held in the Sodi pool, the current payment session, and spending limits.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const s = client.currentSession();
      const p = client.policy;
      return json({
        poolBalanceUsdg: usd(client.poolBalance()),
        session: s
          ? { address: s.address, remainingUsdg: usd(s.remaining), payments: s.payments, ageSeconds: s.ageSeconds }
          : null,
        limits: {
          maxPerRequestUsdg: usd(p.maxPaymentAmount),
          sessionBudgetUsdg: usd(p.budget),
          rotateAfterPayments: p.maxPayments,
          rotateAfterSeconds: p.maxAgeSeconds,
          spentThisRunUsdg: usd(totalSpent),
          maxTotalThisRunUsdg: usd(options.maxTotalSpend),
        },
        ownerControls: (() => {
          const c = client.controls;
          if (!c) return null;
          return {
            paused: c.paused,
            maxPerRequestUsdg: c.maxPaymentAmount ? usd(BigInt(c.maxPaymentAmount)) : null,
            dailyLimitUsdg: c.dailyLimit ? usd(BigInt(c.dailyLimit)) : null,
            spentLast24hUsdg: usd(client.spentSince(Math.floor(Date.now() / 1000) - 86_400)),
            allowedHosts: c.allowedHosts ?? [],
          };
        })(),
      });
    },
  );

  server.registerTool(
    'rx402_fetch',
    {
      title: 'Fetch a URL, paying privately if required',
      description:
        'Fetches an HTTP(S) URL. If the server answers 402 Payment Required (x402), pays in USDG from a private ' +
        'session address that cannot be linked to the owner, then returns the response. Use max_price_usdg to cap ' +
        'what you are willing to pay for this request.',
      inputSchema: {
        url: z.string().url().describe('http or https URL'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
        headers: z.record(z.string()).optional(),
        body: z.string().optional().describe('Request body, e.g. a JSON string'),
        max_price_usdg: z.string().optional().describe('Highest price to accept for this request, e.g. "0.05"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ url, method, headers, body, max_price_usdg }) => {
      const target = new URL(url);
      if (target.protocol !== 'https:' && target.protocol !== 'http:') return fail('only http and https URLs are supported');
      if (options.allowedHosts.length > 0 && !options.allowedHosts.includes(target.hostname)) {
        return fail(`host ${target.hostname} is not in the allowed list`);
      }

      const remainingAllowance = options.maxTotalSpend - totalSpent;
      let cap = remainingAllowance;
      if (max_price_usdg !== undefined) {
        const requested = toUnits(max_price_usdg);
        if (requested < cap) cap = requested;
      }
      if (cap <= 0n) return fail('spending limit for this run has been reached');

      try {
        const { response, payment } = await client.fetch(
          target,
          { method, headers, body: method === 'GET' ? undefined : body },
          { maxPaymentAmount: cap },
        );
        if (payment) totalSpent += payment.amount;
        const text = await response.text();
        return json({
          status: response.status,
          contentType: response.headers.get('content-type'),
          body: text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}… [truncated]` : text,
          payment: payment
            ? { paidUsdg: usd(payment.amount), payTo: payment.payTo, fromSession: payment.from, stealth: payment.stealth }
            : null,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'rx402_open_session',
    {
      title: 'Open a new private payment session',
      description:
        'Withdraws a budget from the private pool to a brand-new address with a zero-knowledge proof. Usually ' +
        'automatic; call this to prepare ahead of a burst of paid requests.',
      inputSchema: { budget_usdg: z.string().optional().describe('Defaults to the configured session budget') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ budget_usdg }) => {
      try {
        const budget = budget_usdg ? toUnits(budget_usdg) : client.policy.budget;
        const s = await client.openSession(budget);
        return json({ address: s.address, budgetUsdg: usd(BigInt(s.budget)), fundingTx: s.fundingTx });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  if (client.canDeposit) {
    server.registerTool(
      'rx402_deposit',
      {
        title: "Deposit the owner's USDG into the private pool",
        description:
          "Moves USDG from the owner's wallet into the Sodi pool. This step is public on-chain. Funds become " +
          'spendable privately once the approval service approves the deposit.',
        inputSchema: { amount_usdg: z.string().describe('Amount to deposit, e.g. "10"') },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async ({ amount_usdg }) => {
        try {
          const note = await client.deposit(toUnits(amount_usdg));
          return json({ depositedUsdg: usd(BigInt(note.value)), tx: note.depositTx });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    );
  }

  return server;
}
