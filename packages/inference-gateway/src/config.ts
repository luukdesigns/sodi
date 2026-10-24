import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { StealthReceiver, parseMetaAddress } from '@sodi/stealth';
import { type Address, type Hex, createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { GatewayConfig } from './app.js';
import { ModelCatalog } from './catalog.js';
import { GuardModelClassifier, RateLimiter } from './guards.js';
import { CreditKeeper, WebhookTopUp } from './keeper.js';
import { PaymentGate } from './payments.js';
import { Upstream } from './upstream.js';

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`${name} is required`);
  return v;
};
const num = (name: string, fallback: string) => {
  const v = Number(env(name, fallback));
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number`);
  return v;
};

/** Builds the gateway from environment variables (see README). Writes nothing about requests anywhere. */
export async function fromEnv(): Promise<{ config: GatewayConfig; port: number; host: string; status: string }> {
  const rpcUrl = env('RPC_URL', 'https://rpc.testnet.chain.robinhood.com');
  const deployment = JSON.parse(
    readFileSync(env('STEALTH_DEPLOYMENT_FILE', resolve(import.meta.dirname, '../../../stealth/deployments/46630.json')), 'utf8'),
  );
  const chainId = deployment.chainId as number;
  const chain = defineChain({ id: chainId, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const facilitator = createWalletClient({ chain, account: privateKeyToAccount(env('FACILITATOR_PRIVATE_KEY') as Hex), transport: http(rpcUrl) });

  // Stealth receive addresses by default; the gateway holds only the viewing key, so it can't move revenue.
  let stealth: StealthReceiver | undefined;
  if (env('STEALTH', 'true') !== 'false') {
    const keys = parseMetaAddress(env('STEALTH_META_ADDRESS'));
    stealth = new StealthReceiver({ ...keys, viewingPrivateKey: env('STEALTH_VIEWING_KEY') as Hex }, env('STEALTH_SETTLER', deployment.SodiStealthSettler) as Address);
  }

  const upstream = new Upstream({
    baseUrl: env('UPSTREAM_URL', 'https://openrouter.ai/api/v1'),
    apiKey: env('OPENROUTER_API_KEY'),
    managementKey: process.env.OPENROUTER_MANAGEMENT_KEY || undefined,
    zdr: env('ZDR', 'false') === 'true',
  });
  const models = env('MODELS')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  let keeper: CreditKeeper | undefined;
  if (process.env.OPENROUTER_MANAGEMENT_KEY && process.env.TOPUP_WEBHOOK_URL) {
    keeper = new CreditKeeper({
      source: upstream,
      topUp: new WebhookTopUp(process.env.TOPUP_WEBHOOK_URL),
      thresholdUsd: num('CREDIT_THRESHOLD_USD', '20'),
      topUpUsd: num('CREDIT_TOPUP_USD', '50'),
      floorUsd: num('CREDIT_FLOOR_USD', '2'),
      intervalMs: num('CREDIT_CHECK_SECONDS', '60') * 1000,
      // A credit balance says nothing about requests, so this is the one thing the gateway may print.
      onError: (err) => console.error(`keeper: ${(err as Error).message}`),
    });
    keeper.start();
  }

  const config: GatewayConfig = {
    upstream,
    catalog: new ModelCatalog(upstream, models),
    payments: new PaymentGate({
      chainId,
      asset: env('ASSET', deployment.acceptedTokens.USDG) as Address,
      payTo: env('PAY_TO') as Address,
      stealth,
      publicClient,
      facilitator,
    }),
    limiter: new RateLimiter(num('RATE_LIMIT', '30'), num('RATE_WINDOW_SECONDS', '60') * 1000),
    abuse: process.env.ABUSE_GUARD_MODEL ? new GuardModelClassifier(upstream, process.env.ABUSE_GUARD_MODEL) : undefined,
    keeper,
    marginBps: num('MARGIN_BPS', '1000'),
    limits: { defaultMaxTokens: num('DEFAULT_MAX_TOKENS', '1024'), maxTokens: num('MAX_TOKENS', '8192') },
    maxBodyBytes: num('MAX_BODY_BYTES', '1000000'),
    publicUrl: process.env.PUBLIC_URL || undefined,
    network: `eip155:${chainId}`,
  };
  const status = `chain ${chainId}, ${models.length} models, margin ${config.marginBps} bps, stealth ${stealth ? 'on' : 'off'}, keeper ${keeper ? 'on' : 'off'}`;
  return { config, port: num('PORT', '8410'), host: env('HOST', '127.0.0.1'), status };
}
