/**
 * The yield pool live on Robinhood Chain testnet (stand-in vault, no real yield), step 2: the live
 * agent pays from a yield-pool session.
 *
 *   the owner deposits USDG through the router -> the funds withdrawn from the first stack are recycled
 *   in through the router, gaslessly -> the approval service screens both against their real
 *   depositors -> the live agent opens a session through the relayer's /fund: sized in shares, it gets
 *   exactly its USDG budget -> it pays an x402 merchant from it.
 *
 *   OWNER_PRIVATE_KEY, RELAYER_PRIVATE_KEY, FACILITATOR_PRIVATE_KEY, RX402_MNEMONIC,
 *   RX402_YIELD_STORE (a new store for this stack), MIGRATION_KEY_FILE
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Address, type Hex, type PublicClient, createPublicClient, createWalletClient, defineChain, formatUnits, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { startServer as startAsp } from '../../../asp/src/server.js';
import { runCycle } from '../../../asp/src/service.js';
import type { ServiceState } from '../../../asp/src/state.js';
import { RelaySubmitter, loadPools } from '../../../relayer/src/relay.js';
import { startServer as startRelayer } from '../../../relayer/src/server.js';
import { FileStore, HttpRelayer, PoolWallet, Rx402Client, WithdrawalProver, aspAssociationSet, erc20Abi, poolFromDeployment } from '../src/index.js';
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
const usd = (v: bigint) => `${formatUnits(v, 6)} USDG`;
const bal = (a: Address) => publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [a] });

const deployment = JSON.parse(readFileSync(new URL('../../../contracts/deployments/46630.json', import.meta.url), 'utf8'));
const ENTRYPOINT = deployment.contracts.Entrypoint as Address;
const USDG = deployment.pools.USDG.asset as Address;
const Y = deployment.yieldPool as { vault: Address; pool: Address; router: Address; funder: Address; superseded: { pool: Address }[] };
const POOLS = [deployment.pools.USDG.pool as Address, ...Y.superseded.map((s) => s.pool), Y.pool];
const MERCHANT = '0x8151fE895E8F0C917Fc1C91581dC8AE5367e29fD' as Address; // the demo APIs' owner
const BUDGET = 20_000n; // 0.02 USDG per session
const PRICE = 1_000n; // 0.001 USDG per request

const owner = wallet(need('OWNER_PRIVATE_KEY'));
const relayerWallet = wallet(need('RELAYER_PRIVATE_KEY'));
const holder = privateKeyToAccount(readFileSync(need('MIGRATION_KEY_FILE'), 'utf8').trim() as Hex);

const aspDir = join(tmpdir(), `sodi-yield2-asp-${Date.now()}`);
const aspState: ServiceState = { chainId: 46630, entrypoint: ENTRYPOINT.toLowerCase(), lastScannedBlock: deployment.deploymentBlock - 1, deposits: [], published: [] };
const asp = startAsp(18542, () => aspState, join(aspDir, 'sets'), '127.0.0.1');
const approve = () =>
  runCycle({
    publicClient,
    walletClient: owner,
    entrypoint: ENTRYPOINT,
    pools: POOLS,
    forwarders: deployment.forwarders,
    policy: { blockedAddresses: new Set(), deniedLabels: new Set(), vettingDelaySeconds: 0 },
    state: aspState,
    stateFile: join(aspDir, 'state.json'),
    setsDir: join(aspDir, 'sets'),
    logChunkSize: 25_000,
    dryRun: false,
  });

const settings = {
  entrypoint: ENTRYPOINT,
  pools: await loadPools(publicClient, ENTRYPOINT, [Y.pool], 50n),
  feeRecipient: relayerWallet.account.address,
  relayFeeBPS: 50n,
  minWithdrawal: 0n,
  recycler: Y.router,
  recycleFee: 0n,
  funder: Y.funder,
};
const relayerServer = startRelayer(18543, 46630, settings, new RelaySubmitter(publicClient, relayerWallet, settings), (m) => console.log(`   [relayer] ${m}`), { host: '127.0.0.1' });
const relayer = await HttpRelayer.connect('http://127.0.0.1:18543', { chainId: 46630, entrypoint: ENTRYPOINT, feeRecipient: relayerWallet.account.address, maxFeeBPS: 50n });
const shop = startMerchant({ port: 18544, asset: USDG, payTo: MERCHANT, facilitator: wallet(need('FACILITATOR_PRIVATE_KEY')), publicClient, prices: { '/quote': { amount: PRICE, version: 2 } } });

const store = new FileStore(need('RX402_YIELD_STORE'));
const common = {
  publicClient,
  mnemonic: need('RX402_MNEMONIC'),
  ...poolFromDeployment(deployment, 'syUSDG'),
  relayer,
  prover: new WithdrawalProver(),
  associationSet: aspAssociationSet('http://127.0.0.1:18542'),
  store,
};
const pool = new PoolWallet({ ...common, ownerWallet: owner });
const agent = new Rx402Client({ ...common, policy: { budget: BUDGET, maxPayments: 20, maxAgeSeconds: 6 * 3600, maxPaymentAmount: 2_000n } });

const record: Record<string, unknown> = {};
try {
  console.log('1. The owner deposits through the router');
  const ownerUsdg = await bal(owner.account.address);
  const n1 = await pool.deposit(ownerUsdg - (ownerUsdg % 1_000n));
  console.log(`   ${formatUnits(BigInt(n1.value), 6)} shares  ${explorer(n1.depositTx)}`);
  record.ownerDeposit = n1.depositTx;

  console.log('2. The funds from the first stack are recycled in through the router, gaslessly');
  const n2 = await pool.recycle(holder, relayer.recycleSubmitter({ recycler: Y.router, maxFee: 0n }));
  console.log(`   ${formatUnits(BigInt(n2.value), 6)} shares from ${holder.address}  ${explorer(n2.depositTx)}`);
  record.recycle = n2.depositTx;

  console.log('3. The approval service screens the real depositors and approves');
  const r = await approve();
  for (const d of aspState.deposits.filter((x) => x.pool === Y.pool.toLowerCase())) console.log(`   ${d.label.slice(0, 10)}… ${d.status}: ${d.kind} from ${d.depositor}`);
  record.aspRoot = r.published?.txHash ?? null;

  console.log('4. The live agent pays from a yield-pool session funded through /fund');
  const { response, payment } = await agent.fetch('http://127.0.0.1:18544/quote');
  const session = agent.currentSession()!;
  console.log(`   paid ${usd(payment!.amount)} from session ${session.address}: HTTP ${response.status}`);
  console.log(`   the session was funded with exactly ${usd(BigInt(session.budget))}  ${explorer(session.fundingTx)}`);
  console.log(`   it now holds ${usd(await bal(session.address))}; the merchant was paid in ${explorer(shop.settlements[0]!.txHash)}`);
  record.session = { address: session.address, budget: session.budget, fundingTx: session.fundingTx, payment: shop.settlements[0]!.txHash };
  console.log(JSON.stringify(record, null, 2));
} finally {
  asp.close();
  relayerServer.close();
  shop.server.close();
  setTimeout(() => process.exit(0), 100);
}
