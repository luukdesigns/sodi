/**
 * Confidential deliverables on ERC-8183.
 *
 *   Orion (client) hires Quill (provider) for a security review; Vera (evaluator) approves it.
 *   The job, budget, state changes, payment and a hash of the report are public. The report itself,
 *   and Vera's review of it, are readable only by the three parties. Eve sees everything else.
 */
import { readFileSync } from 'node:fs';

import { A2AClient, WalletPostRelayer } from '@sodi/a2a';
import { type Address, type Hex, type PublicClient, type WalletClient, encodeFunctionData, formatUnits } from 'viem';

import { erc20Abi, hookAbi } from '../src/abi.js';
import { PrivateJobs } from '../src/client.js';

const artifact = (path: string) => {
  const a = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object as Hex };
};

export interface Deployment {
  commerce: Address;
  hook: Address;
  token: Address;
  registry: Address;
}

/** Deploys the unmodified ERC-8183 reference, a test token and the privacy hook; whitelists the hook. */
export async function deploy(publicClient: PublicClient, admin: WalletClient, registry: Address): Promise<Deployment> {
  const send = async (a: { abi: unknown; bytecode: Hex }, args: unknown[] = []) => {
    const hash = await admin.deployContract({ abi: a.abi as never, bytecode: a.bytecode, args, account: admin.account!, chain: admin.chain } as never);
    return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  const out = '../../contracts/out/';
  const token = await send(artifact(`${out}TestDollar.sol/TestDollar.json`));
  const acp = artifact(`${out}AgenticCommerce.sol/AgenticCommerce.json`);
  const impl = await send(acp);
  const init = encodeFunctionData({ abi: acp.abi as never, functionName: 'initialize', args: [token, admin.account!.address] } as never);
  const commerce = await send(artifact(`${out}ERC1967Proxy.sol/ERC1967Proxy.json`), [impl, init]);
  const hook = await send(artifact(`${out}ConfidentialDeliverableHook.sol/ConfidentialDeliverableHook.json`), [commerce, registry]);

  const call = async (functionName: string, args: unknown[]) => {
    const hash = await admin.writeContract({ address: commerce, abi: acp.abi as never, functionName, args, account: admin.account!, chain: admin.chain } as never);
    await publicClient.waitForTransactionReceipt({ hash });
  };
  const ADMIN_ROLE = await publicClient.readContract({ address: commerce, abi: acp.abi as never, functionName: 'ADMIN_ROLE' } as never);
  await call('grantRole', [ADMIN_ROLE, admin.account!.address]);
  await call('setHookWhitelist', [hook, true]);
  return { commerce, hook, token, registry };
}

export async function runDemo(opts: {
  publicClient: PublicClient;
  /** Client agent; also relays key registrations and mints the test token. */
  client: WalletClient;
  provider: WalletClient;
  evaluator: WalletClient;
  outsider: WalletClient;
  deployment: Deployment;
  log?: (m: string) => void;
}) {
  const log = opts.log ?? console.log;
  const { publicClient, deployment: d } = opts;
  const startBlock = await publicClient.getBlockNumber();
  const relayer = new WalletPostRelayer(opts.client, publicClient, d.registry);

  const party = async (name: string, wallet: WalletClient) => {
    const identity = new A2AClient({ publicClient, wallet, contract: d.registry, relayer });
    await identity.init();
    await identity.register();
    return { name, wallet, jobs: new PrivateJobs({ publicClient, wallet, commerce: d.commerce, hook: d.hook, identity }) };
  };

  log('1. Agents derive messaging keys from wallet signatures and publish them');
  const orion = await party('Orion', opts.client);
  const quill = await party('Quill', opts.provider);
  const vera = await party('Vera', opts.evaluator);
  const eve = await party('Eve', opts.outsider);
  for (const p of [orion, quill, vera, eve]) log(`   ${p.name.padEnd(5)} ${p.jobs.address}`);

  const mintHash = await opts.client.writeContract({
    address: d.token,
    abi: [{ type: 'function', name: 'mint', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }],
    functionName: 'mint',
    args: [orion.jobs.address, 25_000_000n],
    account: opts.client.account!,
    chain: opts.client.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });

  log('2. Orion opens a job with the privacy hook (the description is public, so it stays high level)');
  const { jobId } = await orion.jobs.createJob({
    provider: quill.jobs.address,
    evaluator: vera.jobs.address,
    expiresInSeconds: 86_400,
    description: 'Security review of a token vesting contract',
  });
  log(`   job #${jobId}`);

  log('3. Quill quotes 25 tUSD and Orion funds the escrow');
  await quill.jobs.setBudget(jobId, 25_000_000n);
  await orion.jobs.fund(jobId);

  log('4. Quill submits the report, encrypted to Orion and Vera');
  const report = {
    title: 'Vesting contract review',
    findings: [
      { id: 'H-1', severity: 'high', issue: 'release() can be called before the cliff when start is in the past' },
      { id: 'M-1', severity: 'medium', issue: 'beneficiary change does not reset released amount' },
    ],
    recommendation: 'Fix H-1 before deployment.',
  };
  const sub = await quill.jobs.submitConfidential(jobId, report);
  log(`   public commitment ${sub.deliverable}  (${sub.envelopeBytes}-byte encrypted envelope)`);

  log('5. Vera reads the report and approves it, with a confidential review');
  const forVera = await vera.jobs.readDeliverable(jobId, startBlock);
  if (!forVera) throw new Error('evaluator could not open the deliverable');
  await vera.jobs.complete(jobId, { verdict: 'Findings reproduced; H-1 is real. Approved.' }, { fromBlock: startBlock });

  log('6. Who can read what');
  const views: Record<string, { report: boolean; review: boolean }> = {};
  for (const p of [orion, quill, vera, eve]) {
    const r = await p.jobs.readDeliverable(jobId, startBlock);
    const v = await p.jobs.readReview(jobId, startBlock);
    views[p.name] = { report: r !== null, review: v !== null };
    log(`   ${p.name.padEnd(5)} report: ${r ? `yes (${(r.work as typeof report).findings.length} findings)` : 'no'}   review: ${v ? 'yes' : 'no'}`);
  }

  log('7. What everyone sees on-chain');
  const job = await eve.jobs.getJob(jobId);
  const [ev] = await publicClient.getContractEvents({ address: d.hook, abi: hookAbi, eventName: 'ConfidentialDeliverable', args: { jobId }, fromBlock: startBlock });
  log(`   "${job.description}"  budget ${formatUnits(job.budget, 6)} tUSD  status ${job.statusName}`);
  log(`   deliverable ${ev!.args.deliverable}  envelope ${ev!.args.envelope!.slice(0, 34)}…`);
  const paid = await publicClient.readContract({ address: d.token, abi: erc20Abi, functionName: 'balanceOf', args: [quill.jobs.address] });
  log(`   Quill was paid ${formatUnits(paid, 6)} tUSD`);

  return { jobId, views, status: job.statusName, providerPaid: paid, findingsSeenByEvaluator: (forVera.work as typeof report).findings.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { createPublicClient, createWalletClient, defineChain, http } = await import('viem');
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
  const rpcUrl = process.env.RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';
  const need = (n: string) => {
    const v = process.env[n];
    if (!v) throw new Error(`set ${n}`);
    return v as Hex;
  };
  const publicClient0 = createPublicClient({ transport: http(rpcUrl) });
  const chain = defineChain({
    id: await publicClient0.getChainId(),
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  const wallet = (k: Hex) => createWalletClient({ chain, account: privateKeyToAccount(k), transport: http(rpcUrl) });
  const client = wallet(need('CLIENT_PRIVATE_KEY'));

  const deployment = process.env.COMMERCE
    ? { commerce: need('COMMERCE') as Address, hook: need('HOOK') as Address, token: need('TOKEN') as Address, registry: need('REGISTRY') as Address }
    : await deploy(publicClient, client, need('REGISTRY') as Address);
  console.log('deployment', JSON.stringify(deployment));

  await runDemo({
    publicClient,
    client,
    provider: wallet(need('PROVIDER_PRIVATE_KEY')),
    evaluator: wallet(need('EVALUATOR_PRIVATE_KEY')),
    outsider: wallet(generatePrivateKey()),
    deployment,
  });
}
