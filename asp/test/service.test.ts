import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PublicClient, WalletClient } from 'viem';
import { describe, expect, it } from 'vitest';

import { SENTINEL_LABEL, runCycle } from '../src/service.js';
import type { ServiceState } from '../src/state.js';
import { computeRoot } from '../src/tree.js';

const ENTRYPOINT = '0xaCa6B50b648a6f575a009DC7c97aBe62808869Ce';
const POOL = '0x8cddbb1c33ce49ab72fd1765649835935604bf76';

/** An Entrypoint and pool, as far as the approval service can see them. */
function fakeChain() {
  const deposits: { label: bigint; depositor: string; block: bigint }[] = [];
  let head = 100n;
  let root = 0n;
  const published: bigint[] = [];
  const publicClient = {
    getBlockNumber: async () => head,
    getBlock: async () => ({ timestamp: 1_000n }),
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      deposits
        .filter((d) => d.block >= fromBlock && d.block <= toBlock)
        .map((d, i) => ({
          address: POOL,
          args: { _label: d.label, _depositor: d.depositor, _value: 1n, _commitment: 1n },
          blockNumber: d.block,
          logIndex: i,
          transactionHash: `0x${'00'.repeat(31)}01`,
        })),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'latestRoot') {
        if (root === 0n) throw new Error('NoRootsAvailable()');
        return root;
      }
      if (functionName === 'hasRole') return true;
      throw new Error(functionName);
    },
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  } as unknown as PublicClient;
  const walletClient = {
    account: { address: '0x0000000000000000000000000000000000000001' },
    writeContract: async ({ args }: { args: [bigint, string] }) => {
      root = args[0];
      published.push(args[0]);
      return `0x${'00'.repeat(31)}02`;
    },
  } as unknown as WalletClient;
  return {
    publicClient,
    walletClient,
    published,
    deposit: (label: bigint, depositor: string, block = head) => deposits.push({ label, depositor, block }),
    advance: (n: bigint) => (head += n),
    root: () => root,
  };
}

function ctx(chain: ReturnType<typeof fakeChain>, state: ServiceState, blocked: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'sodi-asp-'));
  return {
    publicClient: chain.publicClient,
    walletClient: chain.walletClient,
    entrypoint: ENTRYPOINT as `0x${string}`,
    pools: [POOL as `0x${string}`],
    policy: { blockedAddresses: new Set(blocked), deniedLabels: new Set<string>(), vettingDelaySeconds: 0 },
    state,
    stateFile: join(dir, 'state.json'),
    setsDir: join(dir, 'sets'),
    logChunkSize: 1_000,
    dryRun: false,
    now: () => 10_000,
  };
}
const fresh = (): ServiceState => ({ chainId: 46630, entrypoint: ENTRYPOINT.toLowerCase(), lastScannedBlock: 0, deposits: [], published: [] });

describe('approval service cycle', () => {
  it('publishes the root once a deposit is approved, and not again while nothing changes', async () => {
    const chain = fakeChain();
    chain.deposit(7n, '0xaa');
    const state = fresh();
    await runCycle(ctx(chain, state));
    expect(chain.root()).toBe(computeRoot([7n]));
    await runCycle(ctx(chain, state));
    expect(chain.published).toHaveLength(1);
  });

  it('after a restart with no state, adopts the root already on-chain and serves its set', async () => {
    const chain = fakeChain();
    chain.deposit(7n, '0xaa');
    await runCycle(ctx(chain, fresh()));
    const restarted = fresh();
    await runCycle(ctx(chain, restarted));
    expect(chain.published).toHaveLength(1);
    expect(restarted.published.at(-1)).toMatchObject({ root: computeRoot([7n]).toString(), labelCount: 1 });
    expect(restarted.published.at(-1)!.txHash).toBeUndefined();
  });

  it('revokes the last approved deposit by publishing a sentinel set', async () => {
    const chain = fakeChain();
    chain.deposit(7n, '0xbad');
    const state = fresh();
    await runCycle(ctx(chain, state));
    expect(chain.root()).toBe(computeRoot([7n]));
    await runCycle(ctx(chain, state, ['0xbad']));
    expect(chain.root()).toBe(computeRoot([SENTINEL_LABEL]));
    expect(state.deposits[0]!.status).toBe('denied');
    await runCycle(ctx(chain, state, ['0xbad']));
    expect(chain.published).toHaveLength(2);
  });

  it('finds a deposit that lands in a range it has already scanned (reorg)', async () => {
    const chain = fakeChain();
    chain.deposit(7n, '0xaa');
    const state = fresh();
    await runCycle(ctx(chain, state));
    chain.deposit(8n, '0xbb', 90n); // re-included below the last scanned block
    chain.advance(5n);
    await runCycle(ctx(chain, state));
    expect(state.deposits.map((d) => d.label).sort()).toEqual(['7', '8']);
    expect(chain.root()).toBe(computeRoot([8n, 7n])); // on-chain order
  });
});
