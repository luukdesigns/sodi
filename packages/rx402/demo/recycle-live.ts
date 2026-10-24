/**
 * Recycling live on Robinhood Chain testnet, with the live agent's own store.
 *
 *   what's left in the agent's finished sessions goes back into the pool through SodiRecycler,
 *   submitted by the relayer -> the approval service approves the new deposits -> a new session is
 *   funded by a zero-knowledge withdrawal from a recycled deposit, proving it's an ordinary note.
 *
 *   OWNER_PRIVATE_KEY        the approval service's postman on this testnet
 *   RELAYER_PRIVATE_KEY      submits recycles and withdrawals
 *   RX402_MNEMONIC, RX402_STORE  the live agent's pool secrets and sessions
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
import { FileStore, HttpRelayer, Rx402Client, WithdrawalProver, aspAssociationSet, erc20Abi } from '../src/index.js';

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
const RECYCLER = deployment.contracts.SodiRecycler as Address;
const usd = (v: bigint) => `${formatUnits(v, 6)} USDG`;
const bal = (a: Address) => publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
const RECYCLE_FEE = 100n; // 0.0001 USDG to the relayer per recycle

const postman = wallet(need('OWNER_PRIVATE_KEY'));
const relayerWallet = wallet(need('RELAYER_PRIVATE_KEY'));

const aspDir = join(tmpdir(), `sodi-recycle-asp-${Date.now()}`);
const aspState: ServiceState = { chainId: 46630, entrypoint: ENTRYPOINT.toLowerCase(), lastScannedBlock: deployment.deploymentBlock - 1, deposits: [], published: [] };
const asp = startAsp(18512, () => aspState, join(aspDir, 'sets'), '127.0.0.1');
const settings = {
  entrypoint: ENTRYPOINT,
  pools: await loadPools(publicClient, ENTRYPOINT, [POOL], 50n),
  feeRecipient: relayerWallet.account.address,
  relayFeeBPS: 50n,
  minWithdrawal: 0n,
  recycler: RECYCLER,
  recycleFee: RECYCLE_FEE,
};
const relayer = startRelayer(18513, 46630, settings, new RelaySubmitter(publicClient, relayerWallet, settings), (m) => console.log(`   [relayer] ${m}`), { host: '127.0.0.1' });
const http_ = await HttpRelayer.connect('http://127.0.0.1:18513', { chainId: 46630, entrypoint: ENTRYPOINT, feeRecipient: relayerWallet.account.address, maxFeeBPS: 50n });

const store = new FileStore(need('RX402_STORE'));
const client = new Rx402Client({
  publicClient,
  mnemonic: need('RX402_MNEMONIC'),
  entrypoint: ENTRYPOINT,
  pool: POOL,
  asset: USDG,
  poolDeploymentBlock: BigInt(deployment.deploymentBlock),
  relayer: http_,
  prover: new WithdrawalProver(),
  associationSet: aspAssociationSet('http://127.0.0.1:18512'),
  store,
  policy: { budget: 35_000n, maxPayments: 10, maxAgeSeconds: 6 * 3600, maxPaymentAmount: 2_000n },
});

try {
  console.log('1. Recycle what is left in finished sessions');
  const outcomes = await client.recycleSessions({ submitter: http_.recycleSubmitter({ recycler: RECYCLER, maxFee: 1_000n }) });
  for (const o of outcomes) console.log(`   ${o.session}: ${usd(o.amount)} ${o.status}${o.tx ? `  ${explorer(o.tx)}` : ''}${o.error ? `  (${o.error})` : ''}`);
  const recycled = outcomes.filter((o) => o.status === 'recycled');
  for (const o of recycled) console.log(`   ${o.session} now holds ${usd(await bal(o.session))}`);

  console.log('2. The approval service approves the new deposits');
  const r = await runCycle({
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
  console.log(`   root ${r.root}${r.published ? `  ${explorer(r.published.txHash)}` : ' (already on-chain)'}`);

  console.log('3. A new session is funded from a recycled deposit');
  const notes = store.load().notes;
  const largestOther = notes.filter((n) => !recycled.some((o) => o.tx === n.depositTx)).reduce((m, n) => (BigInt(n.value) > m ? BigInt(n.value) : m), 0n);
  const fromRecycled = notes.filter((n) => recycled.some((o) => o.tx === n.depositTx)).sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1))[0];
  if (!fromRecycled) throw new Error('no recycled deposit to withdraw from');
  // A budget only the recycled deposit can cover, so the withdrawal must come from it.
  const budget = largestOther + 1n > 35_000n ? largestOther + 1n : 35_000n;
  if (budget > BigInt(fromRecycled.value)) throw new Error(`recycled deposit ${fromRecycled.value} is not the only one that can cover ${budget}`);
  const session = await client.openSession(budget);
  const note = store.load().notes.find((n) => n.label === fromRecycled.label)!;
  console.log(`   session ${session.address} received ${usd(BigInt(session.budget))}  ${explorer(session.fundingTx)}`);
  console.log(`   spent from the recycled deposit: ${note.spendCount === 1 ? 'yes' : 'NO'} (left in it: ${usd(BigInt(note.value))})`);

  console.log(
    JSON.stringify(
      {
        recycles: Object.fromEntries(recycled.map((o) => [o.session, o.tx])),
        tooSmall: outcomes.filter((o) => o.status === 'too-small').map((o) => o.session),
        aspRoot: r.published?.txHash ?? null,
        sessionFromRecycledDeposit: { address: session.address, fundingTx: session.fundingTx, depositLabel: note.label },
      },
      null,
      2,
    ),
  );
} finally {
  asp.close();
  relayer.close();
  // The prover's worker threads keep Node alive; exit explicitly.
  setTimeout(() => process.exit(0), 100);
}
