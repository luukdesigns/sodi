/**
 * The yield pool live on Robinhood Chain testnet (stand-in vault, no real yield), step 1: deposits.
 *
 *   the owner deposits USDG through the router -> two of the live agent's notes in the old pool move to
 *   the yield pool: each is withdrawn with a zero-knowledge proof to a fresh address, then recycled
 *   gaslessly through the router -> the approval service screens every new deposit against its real
 *   depositor, not the router, and approves them.
 *
 *   OWNER_PRIVATE_KEY      deposits; also the approval service's postman on this testnet
 *   RELAYER_PRIVATE_KEY    submits withdrawals and recycles
 *   RX402_MNEMONIC         the live agent's pool secrets (same mnemonic for both pools)
 *   RX402_STORE            the live agent's store for the old pool
 *   RX402_YIELD_STORE      its store for the yield pool
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Address, type Hex, type PublicClient, createPublicClient, createWalletClient, defineChain, formatUnits, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { startServer as startAsp } from '../../../asp/src/server.js';
import { runCycle } from '../../../asp/src/service.js';
import type { ServiceState } from '../../../asp/src/state.js';
import { RelaySubmitter, loadPools } from '../../../relayer/src/relay.js';
import { startServer as startRelayer } from '../../../relayer/src/server.js';
import { FileStore, HttpRelayer, PoolWallet, WithdrawalProver, aspAssociationSet } from '../src/index.js';

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

const deployment = JSON.parse(readFileSync(new URL('../../../contracts/deployments/46630.json', import.meta.url), 'utf8'));
const ENTRYPOINT = deployment.contracts.Entrypoint as Address;
const OLD_POOL = deployment.pools.USDG.pool as Address;
const USDG = deployment.pools.USDG.asset as Address;
const Y = deployment.yieldPool as { vault: Address; pool: Address; router: Address; funder: Address; block: number };

const owner = wallet(need('OWNER_PRIVATE_KEY'));
const relayerWallet = wallet(need('RELAYER_PRIVATE_KEY'));
const prover = new WithdrawalProver();

// Approval service over both pools, screening deposits through the recycler and the router.
const aspDir = join(tmpdir(), `sodi-yield-asp-${Date.now()}`);
const aspState: ServiceState = { chainId: 46630, entrypoint: ENTRYPOINT.toLowerCase(), lastScannedBlock: deployment.deploymentBlock - 1, deposits: [], published: [] };
const asp = startAsp(18522, () => aspState, join(aspDir, 'sets'), '127.0.0.1');
const approve = () =>
  runCycle({
    publicClient,
    walletClient: owner,
    entrypoint: ENTRYPOINT,
    pools: [OLD_POOL, Y.pool],
    forwarders: deployment.forwarders,
    policy: { blockedAddresses: new Set(), deniedLabels: new Set(), vettingDelaySeconds: 0 },
    state: aspState,
    stateFile: join(aspDir, 'state.json'),
    setsDir: join(aspDir, 'sets'),
    logChunkSize: 25_000,
    dryRun: false,
  });

// Relayer: withdrawals from the old pool, and recycles into the yield pool through the router.
const settings = {
  entrypoint: ENTRYPOINT,
  pools: await loadPools(publicClient, ENTRYPOINT, [OLD_POOL], 50n),
  feeRecipient: relayerWallet.account.address,
  relayFeeBPS: 50n,
  minWithdrawal: 0n,
  recycler: Y.router,
  recycleFee: 0n,
};
const relayer = startRelayer(18523, 46630, settings, new RelaySubmitter(publicClient, relayerWallet, settings), (m) => console.log(`   [relayer] ${m}`), { host: '127.0.0.1' });
const httpRelayer = await HttpRelayer.connect('http://127.0.0.1:18523', { chainId: 46630, entrypoint: ENTRYPOINT, feeRecipient: relayerWallet.account.address, maxFeeBPS: 50n });

const common = {
  publicClient,
  mnemonic: need('RX402_MNEMONIC'),
  entrypoint: ENTRYPOINT,
  relayer: httpRelayer,
  prover,
  associationSet: aspAssociationSet('http://127.0.0.1:18522'),
};
const oldPool = new PoolWallet({ ...common, pool: OLD_POOL, asset: USDG, poolDeploymentBlock: BigInt(deployment.deploymentBlock), store: new FileStore(need('RX402_STORE')) });
const yieldPool = new PoolWallet({
  ...common,
  ownerWallet: owner,
  pool: Y.pool,
  asset: USDG,
  yieldPool: { vault: Y.vault, router: Y.router, funder: Y.funder },
  poolDeploymentBlock: BigInt(Y.block),
  store: new FileStore(need('RX402_YIELD_STORE')),
});

const record: Record<string, unknown> = {};
try {
  console.log('0. The approval service catches up');
  await approve();

  console.log('1. The owner deposits through the router');
  const ownerBalance = await publicClient.readContract({ address: USDG, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [owner.account.address] });
  const amount = ownerBalance - (ownerBalance % 1_000n);
  const n1 = await yieldPool.deposit(amount);
  console.log(`   ${usd(amount)} -> ${formatUnits(BigInt(n1.value), 6)} shares in the yield pool  ${explorer(n1.depositTx)}`);
  record.ownerDeposit = n1.depositTx;

  console.log("2. Two of the agent's old-pool notes move to the yield pool");
  const submitter = httpRelayer.recycleSubmitter({ recycler: Y.router, maxFee: 0n });
  record.migrations = [];
  for (const value of [29_900n, 31_650n]) {
    const via = privateKeyToAccount(generatePrivateKey());
    const funding = await oldPool.fund(value, via.address);
    console.log(`   withdrew ${usd(value)} from the old pool to ${via.address}: received ${usd(funding.received)}  ${explorer(funding.fundingTx)}`);
    const note = await yieldPool.recycle(via, submitter, { value: funding.received });
    console.log(`   recycled into the yield pool: ${formatUnits(BigInt(note.value), 6)} shares  ${explorer(note.depositTx)}`);
    (record.migrations as unknown[]).push({ withdrawal: funding.fundingTx, via: via.address, recycle: note.depositTx });
  }

  console.log('3. The approval service screens the real depositors and approves');
  const r = await approve();
  for (const d of aspState.deposits.filter((x) => x.pool === Y.pool.toLowerCase())) {
    console.log(`   ${d.label.slice(0, 10)}… ${d.status}: ${d.kind} from ${d.depositor}${d.via ? ` via ${d.via}` : ''}`);
  }
  console.log(`   root ${r.root}${r.published ? `  ${explorer(r.published.txHash)}` : ' (already on-chain)'}`);
  record.aspRoot = r.published?.txHash ?? null;
  record.yieldPoolDeposits = aspState.deposits.filter((x) => x.pool === Y.pool.toLowerCase()).map((d) => ({ label: d.label, status: d.status, kind: d.kind, depositor: d.depositor, via: d.via }));
  console.log(JSON.stringify(record, null, 2));
} finally {
  asp.close();
  relayer.close();
  setTimeout(() => process.exit(0), 100);
}
