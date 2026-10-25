/**
 * Operator-side sweep: finds the gateway's stealth payments and moves them, paying the margin share
 * to FEE_SINK. Run where the operator's wallet lives, not on the gateway: it derives the spending key.
 *
 *   OPERATOR_PRIVATE_KEY  the wallet the stealth keys were derived from
 *   GAS_PAYER_PRIVATE_KEY pays gas for the gasless transfers
 *   SWEEP_TO              where the operator's part goes
 *   FROM_BLOCK            where to start scanning
 *   FEE_SINK              optional; unset, nothing is split off
 *   MARGIN_SHARE_BPS      share of the margin for FEE_SINK (default 5000)
 *   MARGIN_BPS            the gateway's margin (default 1000)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { StealthMerchant, deriveStealthKeys } from '@sodi/stealth';
import { type Address, type Hex, createPublicClient, createWalletClient, defineChain, formatUnits, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { marginShareOfRevenueBps, sweepRevenue } from './sweep.js';

const env = (n: string, d?: string) => {
  const v = process.env[n] ?? d;
  if (!v) throw new Error(`${n} is required`);
  return v;
};

const rpcUrl = env('RPC_URL', 'https://rpc.testnet.chain.robinhood.com');
const deployment = JSON.parse(readFileSync(env('STEALTH_DEPLOYMENT_FILE', resolve(import.meta.dirname, '../../../stealth/deployments/46630.json')), 'utf8'));
const chain = defineChain({ id: deployment.chainId, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const operator = createWalletClient({ chain, account: privateKeyToAccount(env('OPERATOR_PRIVATE_KEY') as Hex), transport: http(rpcUrl) });
const gasPayer = createWalletClient({ chain, account: privateKeyToAccount(env('GAS_PAYER_PRIVATE_KEY') as Hex), transport: http(rpcUrl) });
const token = env('ASSET', deployment.acceptedTokens.USDG) as Address;
const merchant = new StealthMerchant(await deriveStealthKeys(operator), env('STEALTH_SETTLER', deployment.SodiStealthSettler) as Address);

const payments = await merchant.scan(publicClient as never, { fromBlock: BigInt(env('FROM_BLOCK')), tokens: [token] });
const share = Number(env('MARGIN_SHARE_BPS', '5000'));
const margin = Number(env('MARGIN_BPS', '1000'));
const sink = process.env.FEE_SINK as Address | undefined;
console.error(`${payments.length} payments; ${sink ? `${marginShareOfRevenueBps(share, margin)} bps of each to ${sink}` : 'no fee sink set'}`);
const swept = await sweepRevenue({ merchant, publicClient: publicClient as never, gasPayer, payments, token, domain: { name: 'Global Dollar', version: '1' }, to: env('SWEEP_TO') as Address, feeSink: sink, shareOfMarginBps: share, marginBps: margin });
for (const s of swept) console.error(`${s.stealthAddress}: ${formatUnits(s.amount, 6)} USDG swept${s.split ? `, ${formatUnits(s.split.amount, 6)} to the fee sink` : ''}`);
