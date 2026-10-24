/**
 * Deploys the ERC-8183 reference, the privacy hook and a key registry on a local fork of Robinhood
 * Chain testnet, then runs the audit-job demo and checks who could read what.
 */
import { readFileSync } from 'node:fs';

import { A2AClient, WalletPostRelayer, seal } from '@sodi/a2a';
import { type Hex, type PublicClient, bytesToHex, createPublicClient, createWalletClient, defineChain, http, keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { deploy, runDemo } from '../../demo/audit-job.js';
import { PrivateJobs, agenticCommerceAbi } from '../../src/index.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const chain = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet (fork)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const wallet = (key: Hex) => createWalletClient({ chain, account: privateKeyToAccount(key), transport: http(RPC) });

describe('ERC-8183 job with a confidential deliverable', () => {
  it('keeps the report and review private to client, provider and evaluator', async () => {
    const publicClient = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
    const client = wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

    const a2a = JSON.parse(readFileSync(new URL('../../../../a2a/contracts/out/SodiA2A.sol/SodiA2A.json', import.meta.url), 'utf8'));
    const regHash = await client.deployContract({ abi: a2a.abi, bytecode: a2a.bytecode.object });
    const registry = (await publicClient.waitForTransactionReceipt({ hash: regHash })).contractAddress!;
    const deployment = await deploy(publicClient, client, registry);

    const r = await runDemo({
      publicClient,
      client,
      provider: wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'),
      evaluator: wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'),
      outsider: wallet(generatePrivateKey()), // no gas needed: it only reads
      deployment,
      log: () => {},
    });

    expect(r.status).toBe('Completed');
    expect(r.providerPaid).toBe(25_000_000n);
    expect(r.findingsSeenByEvaluator).toBe(2);
    expect(r.views).toEqual({
      Orion: { report: true, review: true },
      Quill: { report: true, review: true },
      Vera: { report: true, review: true },
      Eve: { report: false, review: false },
    });
  }, 300_000);

  it("gets the client the work even if the provider leaves the client out of the envelope", async () => {
    const publicClient = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
    const clientW = wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    const providerW = wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const evaluatorW = wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
    const a2a = JSON.parse(readFileSync(new URL('../../../../a2a/contracts/out/SodiA2A.sol/SodiA2A.json', import.meta.url), 'utf8'));
    const registry = (await publicClient.waitForTransactionReceipt({ hash: await clientW.deployContract({ abi: a2a.abi, bytecode: a2a.bytecode.object }) })).contractAddress!;
    const d = await deploy(publicClient, clientW, registry);
    const start = await publicClient.getBlockNumber();
    const relayer = new WalletPostRelayer(clientW, publicClient, registry);
    const party = async (w: ReturnType<typeof wallet>) => {
      const identity = new A2AClient({ publicClient, wallet: w, contract: registry, relayer });
      await identity.init();
      await identity.register();
      return { identity, jobs: new PrivateJobs({ publicClient, wallet: w, commerce: d.commerce, hook: d.hook, identity }) };
    };
    const [client, provider, evaluator] = [await party(clientW), await party(providerW), await party(evaluatorW)];
    await publicClient.waitForTransactionReceipt({
      hash: await clientW.writeContract({ address: d.token, abi: [{ type: 'function', name: 'mint', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }], functionName: 'mint', args: [clientW.account.address, 5_000_000n] }),
    });
    const { jobId } = await client.jobs.createJob({ provider: providerW.account.address, evaluator: evaluatorW.account.address, expiresInSeconds: 86_400, description: 'test' });
    await provider.jobs.setBudget(jobId, 5_000_000n);
    await client.jobs.fund(jobId);

    // A provider that seals the work to the evaluator and itself only.
    const envelope = bytesToHex(
      seal(new TextEncoder().encode(JSON.stringify({ kind: 'deliverable', work: { answer: 42 } })), [await client.identity.keyOf(evaluatorW.account.address), provider.identity.keyPair.publicKey], {
        chainId: 46630,
        contract: d.hook,
        channelId: jobId,
        author: providerW.account.address,
      }),
    );
    await publicClient.waitForTransactionReceipt({
      hash: await providerW.writeContract({ address: d.commerce, abi: agenticCommerceAbi, functionName: 'submit', args: [jobId, keccak256(envelope), envelope] }),
    });
    expect(await client.jobs.readDeliverable(jobId, start)).toBeNull(); // the hook can't tell

    // Completing passes the content key to the client inside the review.
    await evaluator.jobs.complete(jobId, { verdict: 'ok' }, { fromBlock: start });
    expect((await client.jobs.readDeliverable(jobId, start))?.work).toEqual({ answer: 42 });
  }, 300_000);
});
