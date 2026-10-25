/**
 * The hosted Sodi services, end to end with a real model, on Robinhood Chain testnet:
 *
 *   relayer.sodi.network      funds a new session from an approved yield-pool note
 *   sodi-asp.onrender.com     serves the approved set the withdrawal proof is built against
 *   inference.sodi.network    answers a paid request from a real model (via OpenRouter)
 *
 * then the real Claude Code CLI through rx402-proxy against the hosted gateway, and the gateway
 * operator finds its payments from the chain alone.
 *
 *   RX402_MNEMONIC, RX402_YIELD_STORE, OPERATOR_KEY_FILE
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StealthMerchant, deriveStealthKeys } from '@sodi/stealth';
import { type Address, type Hex, type PublicClient, createPublicClient, createWalletClient, defineChain, formatUnits, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createPaidProxy } from '../../mcp/src/proxy.js';
import { FileStore, HttpRelayer, Rx402Client, WithdrawalProver, aspAssociationSet, poolFromDeployment } from '../../rx402/src/index.js';
import { checkDelivery } from '../src/digest.js';

const need = (n: string) => {
  if (!process.env[n]) throw new Error(`set ${n}`);
  return process.env[n]!;
};
const RELAYER = 'https://relayer.sodi.network';
const ASP = 'https://sodi-asp.onrender.com';
const GATEWAY = 'https://inference.sodi.network';
const MODEL = 'deepseek/deepseek-v4.1-flash';

const rpcUrl = process.env.RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';
const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
const explorer = (tx: string) => `https://explorer.testnet.chain.robinhood.com/tx/${tx}`;
const usd = (v: bigint) => `${formatUnits(v, 6)} USDG`;

const deployment = JSON.parse(readFileSync(new URL('../../../contracts/deployments/46630.json', import.meta.url), 'utf8'));
const stealthDeployment = JSON.parse(readFileSync(new URL('../../../stealth/deployments/46630.json', import.meta.url), 'utf8'));
const USDG = deployment.pools.USDG.asset as Address;

const record: Record<string, unknown> = { relayer: RELAYER, asp: ASP, gateway: GATEWAY };
const startBlock = await publicClient.getBlockNumber();

// The hosted relayer's terms are checked against what the client will accept before anything is proved.
const relayer = await HttpRelayer.connect(RELAYER, { chainId: 46630, entrypoint: deployment.contracts.Entrypoint as Address, feeRecipient: '0xE1F276aA58A95f0Ab800fd187eCDcf6E23296Bd7', maxFeeBPS: 50n });
const store = new FileStore(need('RX402_YIELD_STORE'));
// maxAgeSeconds 1: the previous session is retired, so a new one is funded through the hosted relayer.
const common = {
  publicClient,
  mnemonic: need('RX402_MNEMONIC'),
  ...poolFromDeployment(deployment, 'syUSDG'),
  relayer,
  prover: new WithdrawalProver(),
  associationSet: aspAssociationSet(ASP),
  store,
};
const agent = new Rx402Client({ ...common, policy: { budget: 30_000n, maxPayments: 20, maxAgeSeconds: 1, maxPaymentAmount: 20_000n } });
// For the proxy: the same store, keeping the session just opened.
const steady = new Rx402Client({ ...common, policy: { budget: 30_000n, maxPayments: 20, maxAgeSeconds: 3600, maxPaymentAmount: 20_000n } });

console.log(`1. A paid request to ${MODEL} through the hosted gateway, from a new session funded by the hosted relayer`);
const body = { model: MODEL, messages: [{ role: 'user', content: 'In two sentences: what is a stealth address on Ethereum?' }], max_tokens: 1000 }; // room for a reasoning model to think and still answer
const { response, payment } = await agent.fetch(`${GATEWAY}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const text = await response.text();
if (response.status !== 200) throw new Error(`gateway answered ${response.status}: ${text.slice(0, 300)}`);
const session = agent.currentSession()!;
const settlement = JSON.parse(Buffer.from(response.headers.get('payment-response')!, 'base64').toString());
const answer = JSON.parse(text);
console.log(`   session ${session.address}, funded with ${usd(BigInt(session.budget))}  ${explorer(session.fundingTx)}`);
console.log(`   paid ${usd(payment!.amount)} at one-time address ${payment!.payTo}  ${explorer(settlement.transaction)}`);
console.log(`   answer: ${answer.choices[0].message.content}`);
console.log(`   usage: ${JSON.stringify(answer.usage ?? null)}`);
console.log(`   delivery digest ${checkDelivery(text, response.headers.get('sodi-delivery-digest')).ok ? 'verified' : 'MISMATCH'}`);
record.session = { address: session.address, budget: session.budget, fundingTx: session.fundingTx };
record.request = { model: MODEL, paid: payment!.amount.toString(), stealthAddress: payment!.payTo, tx: settlement.transaction, answer: answer.choices[0].message.content, usage: answer.usage ?? null };

console.log('2. The real Claude Code CLI through rx402-proxy, against the hosted gateway, with no Anthropic key or account');
const proxyLog: string[] = [];
const proxy = createPaidProxy(steady, { gatewayUrl: GATEWAY, defaultModel: MODEL, maxTokens: 2000, maxTotalSpend: 50_000n, log: (l) => proxyLog.push(l) });
await new Promise<void>((r) => proxy.server.listen(0, '127.0.0.1', r));
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
  const p = spawn('claude', ['-p', 'Reply with one short sentence saying hello from Sodi.', '--max-turns', '1'], { env, cwd: env.HOME });
  let stdout = '';
  let stderr = '';
  p.stdout.on('data', (d) => (stdout += d));
  p.stderr.on('data', (d) => (stderr += d));
  const t = setTimeout(() => p.kill(), 180_000);
  p.on('close', (code) => (clearTimeout(t), code === 0 ? resolve(stdout.trim()) : reject(new Error(`claude exited ${code}: ${stderr.slice(-400)} ${proxyLog.join(' | ')}`))));
  p.stdin.end();
});
proxy.server.close();
console.log(`   claude: ${out}`);
for (const l of proxyLog) console.log(`   proxy: ${l}`);
record.claudeCode = { output: out, proxyLog, spent: proxy.spent().toString() };

console.log("3. The operator finds the gateway's payments from the chain alone");
const operator = createWalletClient({ chain, account: privateKeyToAccount(readFileSync(need('OPERATOR_KEY_FILE'), 'utf8').trim() as Hex), transport: http(rpcUrl) });
const merchant = new StealthMerchant(await deriveStealthKeys(operator), stealthDeployment.SodiStealthSettler as Address);
const found = await merchant.scan(publicClient, { fromBlock: startBlock, tokens: [USDG] });
for (const f of found) console.log(`   ${usd(f.amount!)} at ${f.stealthAddress}  ${explorer(f.txHash)}`);
record.found = found.map((f) => ({ stealthAddress: f.stealthAddress, amount: f.amount!.toString(), tx: f.txHash }));
console.log(JSON.stringify(record, null, 2));
process.exit(0);
