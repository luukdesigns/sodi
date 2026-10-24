/**
 * Leaves the first testnet yield stack, whose funder predates exact-amount sessions, so the vault
 * (which fixes its funder at wiring) can be replaced:
 *
 *   - the owner's deposit is ragequit through the router with a real proof: its USDG goes back to the
 *     owner, with no relayer and no approval needed;
 *   - the two notes migrated in from the old pool are withdrawn with zero-knowledge proofs through the
 *     first funder to an address we keep (MIGRATION_KEY_FILE), ready to be recycled into the new stack.
 *
 *   OWNER_PRIVATE_KEY, RELAYER_PRIVATE_KEY, RX402_MNEMONIC, RX402_YIELD_STORE, MIGRATION_KEY_FILE
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Address, type Hex, type PublicClient, createPublicClient, createWalletClient, defineChain, encodeAbiParameters, formatUnits, http, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { startServer as startAsp } from '../../../asp/src/server.js';
import { runCycle } from '../../../asp/src/service.js';
import type { ServiceState } from '../../../asp/src/state.js';
import { FileStore, PoolWallet, RagequitProver, WithdrawalProver, aspAssociationSet, erc20Abi, funderAbi } from '../src/index.js';

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
const V1 = deployment.yieldPool as { vault: Address; pool: Address; router: Address; funder: Address; block: number };
const owner = wallet(need('OWNER_PRIVATE_KEY'));
const relayer = wallet(need('RELAYER_PRIVATE_KEY'));
const routerAbi = parseAbi([
  'struct RagequitProof { uint256[2] pA; uint256[2][2] pB; uint256[2] pC; uint256[4] pubSignals; }',
  'function ragequit(RagequitProof proof)',
]);
const big = <T extends readonly unknown[]>(xs: T) => xs.map((x) => (Array.isArray(x) ? x.map(BigInt) : BigInt(x as string)));

// The address the migrated notes are withdrawn to; kept so they can be recycled into the new stack.
const keyFile = need('MIGRATION_KEY_FILE');
if (!existsSync(keyFile)) writeFileSync(keyFile, generatePrivateKey(), { mode: 0o600 });
const holder = privateKeyToAccount(readFileSync(keyFile, 'utf8').trim() as Hex);

const aspDir = join(tmpdir(), `sodi-exit-asp-${Date.now()}`);
const aspState: ServiceState = { chainId: 46630, entrypoint: ENTRYPOINT.toLowerCase(), lastScannedBlock: deployment.deploymentBlock - 1, deposits: [], published: [] };
const asp = startAsp(18532, () => aspState, join(aspDir, 'sets'), '127.0.0.1');

const store = new FileStore(need('RX402_YIELD_STORE'));
const v1 = new PoolWallet({
  publicClient,
  mnemonic: need('RX402_MNEMONIC'),
  entrypoint: ENTRYPOINT,
  pool: V1.pool,
  asset: USDG,
  yieldPool: { vault: V1.vault, router: V1.router, funder: V1.funder },
  poolDeploymentBlock: BigInt(V1.block),
  relayer: { feeRecipient: relayer.account.address, relayFeeBPS: 50n, relay: () => Promise.reject(new Error('unused')) },
  prover: new WithdrawalProver(),
  associationSet: aspAssociationSet('http://127.0.0.1:18532'),
  store,
});

const record: Record<string, unknown> = { holder: holder.address };
try {
  console.log('0. The approval service catches up (the set on-chain already approves these notes)');
  await runCycle({
    publicClient,
    walletClient: owner,
    entrypoint: ENTRYPOINT,
    pools: [OLD_POOL, V1.pool],
    forwarders: deployment.forwarders,
    policy: { blockedAddresses: new Set(), deniedLabels: new Set(), vettingDelaySeconds: 0 },
    state: aspState,
    stateFile: join(aspDir, 'state.json'),
    setsDir: join(aspDir, 'sets'),
    logChunkSize: 25_000,
    dryRun: false,
  });
  await v1.sync();
  const notes = store.load().notes;
  const ownerNote = notes.find((n) => n.depositTx === deployment.yieldPool.liveRun.ownerDeposit)!;
  const migrated = notes.filter((n) => n !== ownerNote && BigInt(n.value) > 0n);

  console.log("1. The owner's deposit is ragequit through the router, with a real proof");
  const before = await publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [owner.account.address] });
  const rq = await v1.ragequitProof(ownerNote.label, new RagequitProver());
  const rqTx = await relayer.writeContract({ address: V1.router, abi: routerAbi, functionName: 'ragequit', args: [{ pA: big(rq.pA), pB: big(rq.pB), pC: big(rq.pC), pubSignals: big(rq.pubSignals) } as never] });
  await publicClient.waitForTransactionReceipt({ hash: rqTx });
  const back = (await publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [owner.account.address] })) - before;
  console.log(`   ${usd(back)} back to the owner  ${explorer(rqTx)}`);
  record.ownerRagequit = rqTx;

  console.log(`2. The migrated notes are withdrawn through the first funder to ${holder.address}`);
  record.withdrawals = [];
  for (const note of migrated) {
    // The first funder's data: session, fee recipient, fee, minimum. Withdraw the whole note.
    const data = encodeAbiParameters(
      [{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }] }],
      [[holder.address, relayer.account.address, 50n, 1n]],
    );
    const tx = await v1.withdrawVia(BigInt(note.value), V1.funder, data, async (withdrawal, proof) => {
      const hash = await relayer.writeContract({ address: V1.funder, abi: funderAbi, functionName: 'fund', args: [withdrawal, { pA: big(proof.pA), pB: big(proof.pB), pC: big(proof.pC), pubSignals: big(proof.pubSignals) } as never] });
      await publicClient.waitForTransactionReceipt({ hash });
      return hash;
    });
    console.log(`   ${formatUnits(BigInt(note.value), 6)} shares withdrawn  ${explorer(tx)}`);
    (record.withdrawals as string[]).push(tx);
  }
  const held = await publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [holder.address] });
  console.log(`   ${holder.address} now holds ${usd(held)}`);
  record.held = held.toString();
  console.log(JSON.stringify(record, null, 2));
} finally {
  asp.close();
  setTimeout(() => process.exit(0), 100);
}
