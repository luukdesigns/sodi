/**
 * rx402 live on Robinhood Chain testnet: the whole stack, with real USDG and the deployed pool.
 *
 *   owner deposits USDG (public) -> approval service approves it -> agent pays x402 merchants from
 *   private sessions funded by zero-knowledge withdrawals through the Sodi relayer -> one merchant
 *   offers stealth and is paid at one-time addresses -> the policy rotates to a new session.
 *
 * Roles use separate wallets, as they would in production, so the chain shows no link between them:
 *   OWNER_PRIVATE_KEY        deposits; also the approval service's postman on this testnet
 *   RELAYER_PRIVATE_KEY      submits withdrawals (pays gas, earns the relay fee)
 *   FACILITATOR_PRIVATE_KEY  settles merchant payments (pays gas)
 *   MERCHANT_ADDRESS, MERCHANT_PRIVATE_KEY (for stealth keys), SETTLER
 *   RX402_MNEMONIC, RX402_STORE  the agent's pool secrets and session keys; keep both
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { type Address, type Hex, type PublicClient, createPublicClient, createWalletClient, defineChain, formatUnits, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { startServer as startAsp } from '../../../asp/src/server.js';
import { runCycle } from '../../../asp/src/service.js';
import type { ServiceState } from '../../../asp/src/state.js';
import { RelaySubmitter, loadPools } from '../../../relayer/src/relay.js';
import { startServer as startRelayer } from '../../../relayer/src/server.js';
import { startStealthMerchant } from '../../../stealth/sdk/demo/shop.js';
import { StealthMerchant, StealthReceiver, deriveStealthKeys, viewingOnly } from '../../../stealth/sdk/src/index.js';
import { FileStore, HttpRelayer, Rx402Client, WithdrawalProver, aspAssociationSet, erc20Abi } from '../src/index.js';
import { startMerchant } from '../test/e2e/merchant.js';

const need = (n: string) => {
  if (!process.env[n]) throw new Error(`set ${n}`);
  return process.env[n]!;
};
const rpcUrl = process.env.RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';
const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
const wallet = (k: string) => createWalletClient({ chain, account: privateKeyToAccount(k as Hex), transport: http(rpcUrl) });
const explorer = (tx: string) => `https://explorer.testnet.chain.robinhood.com/tx/${tx}`;

const deployment = JSON.parse(readFileSync(new URL('../../../contracts/deployments/46630.json', import.meta.url), 'utf8'));
const ENTRYPOINT = deployment.contracts.Entrypoint as Address;
const POOL = deployment.pools.USDG.pool as Address;
const USDG = deployment.pools.USDG.asset as Address;
const usd = (v: bigint) => `${formatUnits(v, 6)} USDG`;
const bal = (a: Address) => publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [a] });

const owner = wallet(need('OWNER_PRIVATE_KEY'));
const relayerWallet = wallet(need('RELAYER_PRIVATE_KEY'));
const facilitator = wallet(need('FACILITATOR_PRIVATE_KEY'));
const MERCHANT = need('MERCHANT_ADDRESS') as Address;
const SETTLER = need('SETTLER') as Address;
const DEPOSIT = BigInt(process.env.DEPOSIT ?? '150000');
const PRICE = 5_000n; // 0.005 USDG per request
const RELAY_FEE_BPS = 50n;

// Approval service
const aspDir = join(tmpdir(), `sodi-live-asp-${Date.now()}`);
const aspState: ServiceState = { chainId: 46630, entrypoint: ENTRYPOINT.toLowerCase(), lastScannedBlock: deployment.deploymentBlock - 1, deposits: [], published: [] };
const asp = startAsp(18502, () => aspState, join(aspDir, 'sets'));
const approve = () =>
  runCycle({
    publicClient,
    walletClient: owner,
    entrypoint: ENTRYPOINT,
    pools: [POOL],
    policy: { blockedAddresses: new Set(), deniedLabels: new Set(), vettingDelaySeconds: 0 },
    state: aspState,
    stateFile: join(aspDir, 'state.json'),
    setsDir: join(aspDir, 'sets'),
    logChunkSize: 25_000,
    dryRun: false,
  });

// Relayer
const settings = {
  entrypoint: ENTRYPOINT,
  pools: await loadPools(publicClient, ENTRYPOINT, [POOL], RELAY_FEE_BPS),
  feeRecipient: relayerWallet.account.address,
  relayFeeBPS: RELAY_FEE_BPS,
  minWithdrawal: 10_000n,
};
const relayer = startRelayer(18503, 46630, settings, new RelaySubmitter(publicClient, relayerWallet, settings), (m) => console.log(`   [relayer] ${m}`));

// Merchants: an ordinary x402 API, and one that offers stealth
const plain = startMerchant({ port: 18504, asset: USDG, payTo: MERCHANT, facilitator, publicClient, prices: { '/quote': { amount: PRICE, version: 1 } } });
const stealthKeys = await deriveStealthKeys(wallet(need('MERCHANT_PRIVATE_KEY')));
const stealthShop = startStealthMerchant({
  port: 18505,
  asset: USDG,
  payTo: MERCHANT,
  receiver: new StealthReceiver(viewingOnly(stealthKeys)),
  settler: SETTLER,
  facilitator,
  publicClient,
  price: PRICE,
  chainId: 46630,
});

const client = new Rx402Client({
  publicClient,
  ownerWallet: owner,
  mnemonic: need('RX402_MNEMONIC'),
  entrypoint: ENTRYPOINT,
  pool: POOL,
  asset: USDG,
  poolDeploymentBlock: BigInt(deployment.deploymentBlock),
  relayer: await HttpRelayer.connect('http://127.0.0.1:18503'),
  prover: new WithdrawalProver(),
  associationSet: aspAssociationSet('http://127.0.0.1:18502'),
  store: new FileStore(need('RX402_STORE')),
  policy: { budget: 50_000n, maxPayments: 2, maxAgeSeconds: 3600, maxPaymentAmount: 10_000n },
});

try {
  console.log(`Owner ${owner.account.address}  relayer ${relayerWallet.account.address}  facilitator ${facilitator.account.address}`);
  console.log(`\n1. Owner deposits ${usd(DEPOSIT)} into the pool (public)`);
  const note = await client.deposit(DEPOSIT);
  console.log(`   ${explorer(note.depositTx)}`);

  console.log('\n2. The approval service screens it and publishes the approved set');
  const cycle = await approve();
  console.log(`   approved ${cycle.approved}; root published${cycle.published?.txHash ? ` in ${explorer(cycle.published.txHash)}` : ''}`);

  const startBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
  const calls: [string, string][] = [
    ['ordinary API', 'http://127.0.0.1:18504/quote'],
    ['stealth API', 'http://127.0.0.1:18505/stealth'],
    ['stealth API', 'http://127.0.0.1:18505/stealth'],
    ['ordinary API', 'http://127.0.0.1:18504/quote'],
  ];
  console.log('\n3. The agent pays four x402 requests; sessions rotate every two payments');
  let lastSession = '';
  for (const [label, url] of calls) {
    const { response, payment } = await client.fetch(url);
    if (response.status !== 200 || !payment) throw new Error(`${label}: ${response.status} ${await response.text()}`);
    const session = client.currentSession()!;
    if (session.address !== lastSession) {
      console.log(`   new session ${session.address}, funded by a ZK withdrawal: ${explorer(session.fundingTx)}`);
      lastSession = session.address;
    }
    console.log(`   ${label.padEnd(12)} paid ${usd(payment.amount)} from ${payment.from.slice(0, 10)}… to ${payment.payTo}${payment.stealth ? ' (one-time stealth address)' : ''}`);
  }
  for (const s of [...plain.settlements.map((x) => x.txHash), ...stealthShop.settled.map((x) => x.txHash)]) console.log(`   settled ${explorer(s)}`);

  console.log('\n4. What the merchant sees');
  console.log(`   public address ${MERCHANT} received ${usd(await bal(MERCHANT))} (ordinary API only)`);
  const found = await new StealthMerchant(stealthKeys).scan(publicClient, { fromBlock: startBlock, caller: SETTLER });
  console.log(`   stealth payments found from announcements: ${found.length}, ${found.map((f) => `${usd(f.amount ?? 0n)} at ${f.stealthAddress.slice(0, 10)}…`).join(', ')}`);
  console.log(`   pool balance left for the agent: ${usd(client.poolBalance())}`);
} finally {
  for (const s of [asp, relayer, plain.server, stealthShop.server]) s.close();
}
