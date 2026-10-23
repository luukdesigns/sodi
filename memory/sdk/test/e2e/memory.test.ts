/** Runs the memory demo against fresh contracts on a local fork of Robinhood Chain testnet. */
import { readFileSync } from 'node:fs';

import { type Hex, type PublicClient, createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { runDemo } from '../../demo/memory.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const chain = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet (fork)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const wallet = (key: Hex) => createWalletClient({ chain, account: privateKeyToAccount(key), transport: http(RPC) });
const artifact = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

describe('encrypted agent memory', () => {
  it('recovers, resolves conflicts, detects tampering, shares and rotates', async () => {
    const publicClient = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
    // anvil account 2 (account 0 has an EIP-7702 delegation on testnet, which is also fine)
    const relayer = wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
    const deployed = async (path: string) => {
      const a = artifact(path);
      const hash = await relayer.deployContract({ abi: a.abi, bytecode: a.bytecode.object });
      return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
    };
    const fromBlock = await publicClient.getBlockNumber();
    const memoryContract = await deployed('../../../contracts/out/SodiMemory.sol/SodiMemory.json');
    const registry = await deployed('../../../../a2a/contracts/out/SodiA2A.sol/SodiA2A.json');

    const r = await runDemo({
      publicClient,
      relayerWallet: relayer,
      sage: wallet(generatePrivateKey()), // no gas: everything goes through the relayer
      juno: wallet(generatePrivateKey()),
      memoryContract,
      registry,
      fromBlock,
      log: () => {},
    });

    expect(r).toMatchObject({
      recovered: true,
      conflictCaught: true,
      mergedKeepsBoth: true,
      tamperCaught: true,
      teammateReads: true,
      eveCanRead: false,
      rotated: true,
    });
  }, 300_000);
});
