/**
 * The inference gateway's payment path live on Robinhood Chain testnet.
 *
 *   the owner deposits USDG into the yield pool -> the approval service approves it -> an rx402 agent
 *   asks the gateway a question: 402, a session funded through the relayer, a payment settled at a
 *   stealth address -> the real Claude Code CLI runs through rx402-proxy, paying the same way -> the
 *   gateway operator finds its payments from the chain alone.
 *
 * Everything on-chain is real. The upstream is the mock OpenRouter from the tests: no real model is
 * called and no OpenRouter credit is spent, so the answers are canned.
 *
 *   OWNER_PRIVATE_KEY, POSTMAN_PRIVATE_KEY, RELAYER_PRIVATE_KEY, RX402_MNEMONIC, RX402_YIELD_STORE,
 *   OPERATOR_KEY_FILE (created if missing: the gateway operator's wallet, for its stealth keys)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serve } from '@hono/node-server';
import { StealthMerchant, StealthReceiver, deriveStealthKeys, viewingOnly } from '@sodi/stealth';
import { type Address, type Hex, type PublicClient, createPublicClient, createWalletClient, defineChain, formatUnits, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { startServer as startAsp } from '../../../asp/src/server.js';
import { runCycle } from '../../../asp/src/service.js';
import type { ServiceState } from '../../../asp/src/state.js';
import { RelaySubmitter, loadPools } from '../../../relayer/src/relay.js';
import { startServer as startRelayer } from '../../../relayer/src/server.js';
import { createPaidProxy } from '../../mcp/src/proxy.js';
import { FileStore, HttpRelayer, PoolWallet, Rx402Client, WithdrawalProver, aspAssociationSet, erc20Abi, poolFromDeployment } from '../../rx402/src/index.js';
import { createGateway } from '../src/app.js';
import { ModelCatalog } from '../src/catalog.js';
import { DIGEST_HEADER, deliveryDigest } from '../src/digest.js';
import { RateLimiter } from '../src/guards.js';
import { PaymentGate } from '../src/payments.js';
import { Upstream } from '../src/upstream.js';
import { API_KEY, startMockOpenRouter } from '../test/mock-openrouter.js';

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
const stealthDeployment = JSON.parse(readFileSync(new URL('../../../stealth/deployments/46630.json', import.meta.url), 'utf8'));
const ENTRYPOINT = deployment.contracts.Entrypoint as Address;
const USDG = deployment.pools.USDG.asset as Address;
const SETTLER = stealthDeployment.SodiStealthSettler as Address;
const Y = deployment.yieldPool as { pool: Address; router: Address; funder: Address; superseded: { pool: Address }[] };
const POOLS = [deployment.pools.USDG.pool as Address, ...Y.superseded.map((s) => s.pool), Y.pool];
const DEPOSIT = 1_000_000n; // 1 USDG

const owner = wallet(need('OWNER_PRIVATE_KEY'));
const postman = wallet(need('POSTMAN_PRIVATE_KEY')); // also the gateway's facilitator: it pays settlement gas
const relayerWallet = wallet(need('RELAYER_PRIVATE_KEY'));
const operatorKeyFile = need('OPERATOR_KEY_FILE');
if (!existsSync(operatorKeyFile)) writeFileSync(operatorKeyFile, generatePrivateKey(), { mode: 0o600 });
const operator = wallet(readFileSync(operatorKeyFile, 'utf8').trim());

const servers: { close(): unknown }[] = [];
const record: Record<string, unknown> = { upstream: 'mock OpenRouter (canned answers; no model called, no credit spent)' };
try {
  const startBlock = await publicClient.getBlockNumber();

  // The gateway, on the mock upstream, offering stealth addresses derived from the operator's wallet.
  const mock = await startMockOpenRouter();
  servers.push({ close: () => mock.close() });
  const upstream = new Upstream({ baseUrl: mock.url, apiKey: API_KEY });
  const keys = await deriveStealthKeys(operator);
  const gateway = createGateway({
    upstream,
    catalog: new ModelCatalog(upstream, ['test/small', 'test/long']),
    payments: new PaymentGate({ chainId: 46630, asset: USDG, payTo: operator.account.address, stealth: new StealthReceiver(viewingOnly(keys), SETTLER), publicClient, facilitator: postman }),
    limiter: new RateLimiter(30, 60_000),
    marginBps: 1000,
    limits: { defaultMaxTokens: 1024, maxTokens: 8192 },
    network: 'eip155:46630',
  });
  const gatewayServer = await new Promise<Server>((r) => {
    const s = serve({ fetch: gateway.fetch, port: 18560, hostname: '127.0.0.1' }, () => r(s as Server));
  });
  servers.push(gatewayServer);
  record.gatewayOperator = operator.account.address;

  // Approval service and relayer, as in the yield-pool runs.
  const aspDir = join(tmpdir(), `sodi-gateway-live-asp-${Date.now()}`);
  const aspState: ServiceState = { chainId: 46630, entrypoint: ENTRYPOINT.toLowerCase(), lastScannedBlock: deployment.deploymentBlock - 1, deposits: [], published: [] };
  servers.push(startAsp(18561, () => aspState, join(aspDir, 'sets'), '127.0.0.1'));
  const settings = {
    entrypoint: ENTRYPOINT,
    pools: await loadPools(publicClient, ENTRYPOINT, [Y.pool], 50n),
    feeRecipient: relayerWallet.account.address,
    relayFeeBPS: 50n,
    minWithdrawal: 0n,
    funder: Y.funder,
  };
  servers.push(startRelayer(18562, 46630, settings, new RelaySubmitter(publicClient, relayerWallet, settings), () => {}, { host: '127.0.0.1' }));
  const relayer = await HttpRelayer.connect('http://127.0.0.1:18562', { chainId: 46630, entrypoint: ENTRYPOINT, feeRecipient: relayerWallet.account.address, maxFeeBPS: 50n });

  const store = new FileStore(need('RX402_YIELD_STORE'));
  const common = {
    publicClient,
    mnemonic: need('RX402_MNEMONIC'),
    ...poolFromDeployment(deployment, 'syUSDG'),
    relayer,
    prover: new WithdrawalProver(),
    associationSet: aspAssociationSet('http://127.0.0.1:18561'),
    store,
  };
  const pool = new PoolWallet({ ...common, ownerWallet: owner });
  const agent = new Rx402Client({ ...common, policy: { budget: 50_000n, maxPayments: 20, maxAgeSeconds: 6 * 3600, maxPaymentAmount: 20_000n } });

  console.log(`1. The owner deposits ${usd(DEPOSIT)} into the yield pool`);
  const note = await pool.deposit(DEPOSIT);
  console.log(`   ${formatUnits(BigInt(note.value), 6)} shares  ${explorer(note.depositTx)}`);
  record.deposit = note.depositTx;

  console.log('2. The approval service screens the depositor and approves');
  const cycle = await runCycle({
    publicClient,
    walletClient: postman,
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
  const mine = aspState.deposits.find((d) => d.txHash?.toLowerCase() === note.depositTx.toLowerCase());
  console.log(`   ${mine?.status}: ${mine?.kind} from ${mine?.depositor}  ${cycle.published ? explorer(cycle.published.txHash) : '(root already current)'}`);
  record.aspRoot = cycle.published?.txHash ?? null;

  console.log('3. The agent asks the gateway a question, paying from a private session');
  const body = { model: 'test/small', messages: [{ role: 'user', content: 'What is a stealth address?' }], max_tokens: 300 };
  const { response, payment } = await agent.fetch('http://127.0.0.1:18560/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`gateway answered ${response.status}: ${text}`);
  const session = agent.currentSession()!;
  const settlement = JSON.parse(Buffer.from(response.headers.get('payment-response')!, 'base64').toString());
  console.log(`   session ${session.address}, funded with exactly ${usd(BigInt(session.budget))}  ${explorer(session.fundingTx)}`);
  console.log(`   paid ${usd(payment!.amount)} at one-time address ${payment!.payTo}  ${explorer(settlement.transaction)}`);
  console.log(`   answer: ${JSON.parse(text).choices[0].message.content}`);
  console.log(`   delivery digest ${response.headers.get(DIGEST_HEADER) === deliveryDigest(text) ? 'verified' : 'MISMATCH'}`);
  record.session = { address: session.address, budget: session.budget, fundingTx: session.fundingTx };
  record.payments = [{ via: 'rx402 agent', amount: payment!.amount.toString(), stealthAddress: payment!.payTo, tx: settlement.transaction }];

  console.log('4. The real Claude Code CLI, through rx402-proxy, with no Anthropic key or account');
  const proxyLog: string[] = [];
  const proxy = createPaidProxy(agent, { gatewayUrl: 'http://127.0.0.1:18560', defaultModel: 'test/long', maxTokens: 4000, maxTotalSpend: 100_000n, log: (l) => proxyLog.push(l) });
  await new Promise<void>((r) => proxy.server.listen(0, '127.0.0.1', r));
  servers.push(proxy.server);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(ANTHROPIC|CLAUDE)/.test(k)) env[k] = v;
  Object.assign(env, {
    HOME: mkdtempSync(join(tmpdir(), 'claude-home-')),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`,
    ANTHROPIC_API_KEY: 'unused',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn('claude', ['-p', 'Say hello.', '--max-turns', '1'], { env, cwd: env.HOME });
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.on('close', (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(`claude exited ${code}`))));
    p.stdin.end();
  });
  console.log(`   claude: ${out}`);
  for (const l of proxyLog) console.log(`   proxy: ${l}`);
  console.log(`   the proxy paid ${usd(proxy.spent())} in total`);
  record.claudeCode = { output: out, proxyLog, spent: proxy.spent().toString() };

  console.log("5. The operator finds the gateway's payments from the chain alone");
  const merchant = new StealthMerchant(keys, SETTLER);
  const found = await merchant.scan(publicClient, { fromBlock: startBlock, tokens: [USDG] });
  for (const f of found) console.log(`   ${usd(f.amount!)} at ${f.stealthAddress}  ${explorer(f.txHash)}`);
  console.log(`   ${found.length} payments, nothing at the operator's public address (${usd(await bal(operator.account.address))})`);
  record.found = found.map((f) => ({ stealthAddress: f.stealthAddress, amount: f.amount!.toString(), tx: f.txHash }));
  console.log(JSON.stringify(record, null, 2));
} finally {
  for (const s of servers) s.close();
  setTimeout(() => process.exit(0), 200);
}
