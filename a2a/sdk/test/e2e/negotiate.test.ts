/**
 * Runs the negotiation demo against a freshly deployed SodiA2A on a local fork of Robinhood Chain
 * testnet and checks who could read what. Run with test/e2e/run-fork.sh.
 */
import { readFileSync } from 'node:fs';

import { type Hex, type PublicClient, createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { runDemo } from '../../demo/negotiate.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const chain = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet (fork)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
// anvil's first default account acts as the relayer/coordinator
const relayer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

describe('sealed-bid negotiation between agents', () => {
  it('keeps every bid private to the buyer', async () => {
    const publicClient = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
    const relayerWallet = createWalletClient({ chain, account: relayer, transport: http(RPC) });

    const artifact = JSON.parse(
      readFileSync(new URL('../../../contracts/out/SodiA2A.sol/SodiA2A.json', import.meta.url), 'utf8'),
    );
    const hash = await relayerWallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object as Hex });
    const contract = (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;

    const r = await runDemo({ publicClient, relayerWallet, contract, log: () => {} });

    expect(r.winner).toBe('Cinder');
    // The buyer sees all three bids.
    expect(r.views.Atlas).toEqual(expect.arrayContaining(['Bolt:bid@0.52', 'Cinder:bid@0.47', 'Drift:bid@0.49']));
    // Each seller sees the RFQ, its own bid and its outcome, but never a competitor's bid.
    expect(r.views.Cinder).toEqual(['Atlas:rfq', 'Cinder:bid@0.47', 'Atlas:award']);
    expect(r.views.Bolt).toEqual(['Atlas:rfq', 'Bolt:bid@0.52', 'Atlas:not-selected']);
    expect(r.views.Drift).toEqual(['Atlas:rfq', 'Drift:bid@0.49', 'Atlas:not-selected']);
    // The outsider can read nothing and cannot post.
    expect(r.views.Eve).toEqual([]);
    expect(r.outsiderPostRejected).toBe(true);
    // On-chain: six envelopes, all bids padded to the same size.
    expect(r.onChain).toHaveLength(6);
    const bidSizes = r.onChain.filter((x) => ['Bolt', 'Cinder', 'Drift'].includes(x.author)).map((x) => x.bytes);
    expect(new Set(bidSizes).size).toBe(1);
  }, 300_000);
});
