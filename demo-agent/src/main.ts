/**
 * Runs the public demo: the agent, the APIs it buys from, the approval service and relayer it relies
 * on, and a public page with its live activity.
 *
 * Environment:
 *   RX402_MNEMONIC, RX402_STORE        the agent's pool secrets and sessions (fund the pool first)
 *   RX402_CONTROLS                     owner controls; point the dashboard at the same file
 *   POSTMAN_PRIVATE_KEY                publishes approved sets (approval service)
 *   RELAYER_PRIVATE_KEY                submits withdrawals (relayer)
 *   FACILITATOR_PRIVATE_KEY            settles the APIs' payments
 *   MERCHANT_PRIVATE_KEY               the APIs' owner; its stealth keys are derived from it
 *   SETTLER                            SodiStealthSettler address
 *   DEMO_INTERVAL                      seconds between cycles (default 300)
 *   PUBLIC_PORT, PUBLIC_HOST           the public page (default 8490 on 0.0.0.0)
 *   FEED_FILE                          where the feed is kept across restarts
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileControls, FileStore, HttpRelayer, Rx402Client, WithdrawalProver, aspAssociationSet } from '@sodi/rx402';
import { StealthReceiver, deriveStealthKeys, viewingOnly } from '@sodi/stealth';
import { type Address, type Hex, type PublicClient, createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { startServer as startAsp } from '../../asp/src/server.js';
import { runCycle as approveDeposits } from '../../asp/src/service.js';
import type { ServiceState } from '../../asp/src/state.js';
import { RelaySubmitter, loadPools } from '../../relayer/src/relay.js';
import { startServer as startRelayer } from '../../relayer/src/server.js';
import { runCycle } from './agent.js';
import { startApis } from './apis.js';
import { FeedLog } from './feed.js';

const need = (n: string) => {
  if (!process.env[n]) throw new Error(`set ${n}`);
  return process.env[n]!;
};
const env = (n: string, d: string) => process.env[n] ?? d;

const rpcUrl = env('RPC_URL', 'https://rpc.testnet.chain.robinhood.com');
const chainId = await createPublicClient({ transport: http(rpcUrl) }).getChainId();
const chain = defineChain({ id: chainId, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
const wallet = (k: string) => createWalletClient({ chain, account: privateKeyToAccount(k as Hex), transport: http(rpcUrl) });
const deployment = JSON.parse(readFileSync(new URL(`../../contracts/deployments/${chainId}.json`, import.meta.url), 'utf8'));
const ENTRYPOINT = deployment.contracts.Entrypoint as Address;
const POOL = deployment.pools.USDG.pool as Address;
const USDG = deployment.pools.USDG.asset as Address;
const interval = Number(env('DEMO_INTERVAL', '300'));
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

// Approval service, refreshed every cycle so new deposits get approved.
const aspDir = join(tmpdir(), 'sodi-demo-asp');
const aspState: ServiceState = { chainId, entrypoint: ENTRYPOINT.toLowerCase(), lastScannedBlock: deployment.deploymentBlock - 1, deposits: [], published: [] };
const postman = wallet(need('POSTMAN_PRIVATE_KEY'));
const approve = () =>
  approveDeposits({
    publicClient,
    walletClient: postman,
    entrypoint: ENTRYPOINT,
    pools: [POOL],
    policy: { blockedAddresses: new Set(), deniedLabels: new Set(), vettingDelaySeconds: 0 },
    state: aspState,
    stateFile: join(aspDir, 'state.json'),
    setsDir: join(aspDir, 'sets'),
    logChunkSize: 25_000,
    dryRun: false,
  });
startAsp(18702, () => aspState, join(aspDir, 'sets'), '127.0.0.1');

// Relayer
const relayerWallet = wallet(need('RELAYER_PRIVATE_KEY'));
const settings = {
  entrypoint: ENTRYPOINT,
  pools: await loadPools(publicClient, ENTRYPOINT, [POOL], 50n),
  feeRecipient: relayerWallet.account.address,
  relayFeeBPS: 50n,
  minWithdrawal: 5_000n,
};
startRelayer(18703, chainId, settings, new RelaySubmitter(publicClient, relayerWallet, settings), (m) => log(`relayer: ${m}`), { host: '127.0.0.1' });

// The APIs
const merchant = wallet(need('MERCHANT_PRIVATE_KEY'));
startApis({
  port: 18704,
  chainId,
  asset: USDG,
  domain: { name: 'Global Dollar', version: '1' },
  price: 1_000n, // 0.001 USDG
  payTo: merchant.account.address,
  receiver: new StealthReceiver(viewingOnly(await deriveStealthKeys(merchant))),
  settler: need('SETTLER') as Address,
  facilitator: wallet(need('FACILITATOR_PRIVATE_KEY')),
  publicClient,
});

// The agent
const client = new Rx402Client({
  publicClient,
  mnemonic: need('RX402_MNEMONIC'),
  entrypoint: ENTRYPOINT,
  pool: POOL,
  asset: USDG,
  poolDeploymentBlock: BigInt(deployment.deploymentBlock),
  relayer: await HttpRelayer.connect('http://127.0.0.1:18703', { chainId, entrypoint: ENTRYPOINT, feeRecipient: relayerWallet.account.address, maxFeeBPS: 50n }),
  prover: new WithdrawalProver(),
  associationSet: aspAssociationSet('http://127.0.0.1:18702'),
  store: new FileStore(need('RX402_STORE')),
  controls: new FileControls(env('RX402_CONTROLS', join(homedir(), '.sodi', 'controls.json'))),
  // Ten 0.001 payments per session; the extra 50 covers the relayer's 0.5% fee, so nothing is left behind.
  policy: { budget: 10_050n, maxPayments: 10, maxAgeSeconds: 6 * 3600, maxPaymentAmount: 2_000n },
});

const feed = new FeedLog(process.env.FEED_FILE, {
  name: 'Sodi demo agent',
  chainId,
  pool: POOL,
  startedAt: Math.floor(Date.now() / 1000),
  intervalSeconds: interval,
});

// Public page
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const publicPort = Number(env('PUBLIC_PORT', '8490'));
createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (path === '/feed.json') return void res.writeHead(200, { ...headers, 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify(feed.get()));
  if (path === '/health') return void res.writeHead(200, headers).end('ok');
  if (path === '/') {
    return void res
      .writeHead(200, {
        ...headers,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      })
      .end(page);
  }
  res.writeHead(404, headers).end();
}).listen(publicPort, env('PUBLIC_HOST', '0.0.0.0'));
log(`public page on http://localhost:${publicPort}/`);

let cycle = 0;
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stopping = true));
const maxCycles = Number(env('DEMO_CYCLES', '0')); // 0 = run until stopped

while (!stopping) {
  try {
    await approve();
    await runCycle({ client, feed, apiBase: 'http://127.0.0.1:18704', cycle });
    const last = feed.get().events.at(-1);
    log(`cycle ${cycle}: ${last ? JSON.stringify(last).slice(0, 160) : 'nothing'}`);
  } catch (err) {
    log(`cycle ${cycle} failed: ${(err as Error).message.split('\n')[0]}`);
  }
  cycle++;
  if (maxCycles && cycle >= maxCycles) break;
  for (let waited = 0; waited < interval && !stopping; waited++) await new Promise((r) => setTimeout(r, 1000));
}
// The prover's worker threads keep Node alive; exit explicitly.
process.exit(0);
