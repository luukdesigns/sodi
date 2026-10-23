/**
 * Deploys the ERC-8183 reference, the privacy hook and a key registry on a local fork of Robinhood
 * Chain testnet, then runs the audit-job demo and checks who could read what.
 */
import { readFileSync } from 'node:fs';

import { type Hex, type PublicClient, createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { deploy, runDemo } from '../../demo/audit-job.js';

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
});
