/**
 * Starts the owner dashboard for an rx402 agent on this machine.
 *
 *   npm start
 *
 * Environment (the same paths the agent and the Sodi MCP server use):
 *   RX402_STORE      default ~/.sodi/rx402.json
 *   RX402_CONTROLS   default ~/.sodi/controls.json
 *   RPC_URL          default Robinhood Chain testnet
 *   ASP_URL          approval service, for deposit status (optional)
 *   DASHBOARD_PORT   default 8480
 *   DASHBOARD_READ_ONLY=1  also print a read-only link
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { FileControls, FileStore, erc20Abi } from '@sodi/rx402';
import { type Address, createPublicClient, http } from 'viem';

import { newToken, startDashboard } from './server.js';

const env = (k: string, d: string) => process.env[k] ?? d;
const rpcUrl = env('RPC_URL', 'https://rpc.testnet.chain.robinhood.com');
const publicClient = createPublicClient({ transport: http(rpcUrl) });
const chainId = await publicClient.getChainId();
const deployment = JSON.parse(
  readFileSync(env('DEPLOYMENT_FILE', new URL(`../../contracts/deployments/${chainId}.json`, import.meta.url).pathname), 'utf8'),
);
const asset = deployment.pools.USDG.asset as Address;
const aspUrl = process.env.ASP_URL;
const controls = new FileControls(env('RX402_CONTROLS', join(homedir(), '.sodi', 'controls.json')));
const port = Number(env('DASHBOARD_PORT', '8480'));

/**
 * Each lookup tells the RPC provider (or approval service) about addresses that are yours, all from
 * one IP. Cache them for a while so the dashboard doesn't announce your whole set of sessions every
 * few seconds; point RPC_URL at a node you run for full privacy.
 */
const CACHE_SECONDS = Number(env('DASHBOARD_CACHE_SECONDS', '300'));
function cached<K, V>(fn: (k: K) => Promise<V>): (k: K) => Promise<V> {
  const memo = new Map<K, { at: number; value: Promise<V> }>();
  return (k) => {
    const hit = memo.get(k);
    if (hit && Date.now() / 1000 - hit.at < CACHE_SECONDS) return hit.value;
    const value = fn(k);
    memo.set(k, { at: Date.now() / 1000, value });
    value.catch(() => memo.delete(k));
    return value;
  };
}

const { ownerToken, viewerToken } = startDashboard({
  port,
  sources: {
    store: new FileStore(env('RX402_STORE', join(homedir(), '.sodi', 'rx402.json'))),
    controls,
    chainId,
    asset,
    explorer: chainId === 4663 ? 'https://robin.etherscan.io' : chainId === 46630 ? 'https://explorer.testnet.chain.robinhood.com' : undefined,
    balanceOf: cached((address: Address) => publicClient.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [address] })),
    approvalOf: aspUrl
      ? cached(async (label: string) => {
          const r = await fetch(`${aspUrl}/deposits/${label}`);
          return r.ok ? ((await r.json()) as { status: string }).status : undefined;
        })
      : undefined,
  },
  saveControls: (c) => controls.save(c),
  viewerToken: process.env.DASHBOARD_READ_ONLY === '1' ? newToken() : undefined,
  log: (m) => console.log(m),
});

console.log(`Sodi dashboard: http://127.0.0.1:${port}/#token=${ownerToken}`);
if (viewerToken) console.log(`Read-only link: http://127.0.0.1:${port}/#token=${viewerToken}`);
console.log('The link is the password. A new one is made each time the dashboard starts.');
