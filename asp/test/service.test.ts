import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type PublicClient, type WalletClient, encodeAbiParameters, encodeEventTopics } from 'viem';
import { describe, expect, it } from 'vitest';

import { forwarderEvents } from '../src/chain.js';
import { SENTINEL_LABEL, runCycle } from '../src/service.js';
import type { ServiceState } from '../src/state.js';
import { computeRoot } from '../src/tree.js';

const ENTRYPOINT = '0xaCa6B50b648a6f575a009DC7c97aBe62808869Ce';
const POOL = '0x8cddbb1c33ce49ab72fd1765649835935604bf76';

const ROUTER = '0x00000000000000000000000000000000000000a0';
const RECYCLER = '0x00000000000000000000000000000000000000c0';
const SOMEONE = '0x00000000000000000000000000000000000000d1';
const EVIL = '0x00000000000000000000000000000000000000e1';
const WALLET = '0x00000000000000000000000000000000000000f1';

/** An Entrypoint and pool, as far as the approval service can see them. */
function fakeChain() {
  const deposits: { label: bigint; depositor: string; block: bigint; commitment: bigint; forwarded?: { by: string; from: string; commitment: bigint; event: 'Recycled' | 'Deposited' }; safeEvent?: boolean }[] = [];
  const code = new Map<string, string>([
    [ROUTER, '0x6001'],
    [RECYCLER, '0x6001'],
    [WALLET, '0x6001'],
  ]);
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
          args: { _label: d.label, _depositor: d.depositor, _value: 1n, _commitment: d.commitment },
          blockNumber: d.block,
          logIndex: i,
          transactionHash: `0x${d.label.toString(16).padStart(64, '0')}`,
        })),
    getCode: async ({ address }: { address: string }) => code.get(address.toLowerCase()) ?? '0x',
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const d = deposits.find((x) => BigInt(hash) === x.label)!;
      const f = d.forwarded;
      if (!f) {
        // A Safe's own event: ExecutionSuccess(bytes32 txHash, uint256 payment), nothing about the deposit.
        const safeLog = { address: d.depositor, topics: [`0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e`], data: `0x${'ab'.repeat(32)}${'00'.repeat(32)}`, blockNumber: d.block, logIndex: 0, transactionHash: hash };
        return { logs: d.safeEvent ? [safeLog] : [] };
      }
      const event = forwarderEvents.find((e) => e.name === f.event)!;
      const data =
        f.event === 'Recycled'
          ? encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }], [1n, 0n, SOMEONE])
          : encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1n, 1n]);
      return {
        logs: [{ address: f.by, topics: encodeEventTopics({ abi: [event], args: { from: f.from as `0x${string}`, commitment: f.commitment } } as never), data, blockNumber: d.block, logIndex: 0, transactionHash: hash }],
      };
    },
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
    deposit: (label: bigint, depositor: string, block = head, safeEvent = false) => deposits.push({ label, depositor, block, commitment: label * 10n, safeEvent }),
    /** A deposit the pool credits to `by`, which emitted `event` naming `from` for `commitment`. */
    forwarded: (label: bigint, by: string, from: string, event: 'Recycled' | 'Deposited' = 'Deposited', commitment = label * 10n) =>
      deposits.push({ label, depositor: by, block: head, commitment: label * 10n, forwarded: { by, from, commitment, event } }),
    setCode: (a: string, c: string) => code.set(a, c),
    advance: (n: bigint) => (head += n),
    root: () => root,
  };
}

function ctx(chain: ReturnType<typeof fakeChain>, state: ServiceState, blocked: string[] = [], allowedContracts: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'sodi-asp-'));
  return {
    publicClient: chain.publicClient,
    walletClient: chain.walletClient,
    entrypoint: ENTRYPOINT as `0x${string}`,
    pools: [POOL as `0x${string}`],
    forwarders: [ROUTER, RECYCLER] as `0x${string}`[],
    policy: { blockedAddresses: new Set(blocked), deniedLabels: new Set<string>(), vettingDelaySeconds: 0, allowedContracts: new Set(allowedContracts) },
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

  describe('the real depositor behind the router and the recycler', () => {
    const statusOf = (state: ServiceState, label: string) => state.deposits.find((d) => d.label === label)!;

    it('screens the depositor named by the router, not the router', async () => {
      const chain = fakeChain();
      chain.forwarded(7n, ROUTER, SOMEONE);
      const state = fresh();
      await runCycle(ctx(chain, state));
      expect(statusOf(state, '7')).toMatchObject({ status: 'approved', kind: 'forwarded', depositor: SOMEONE, via: ROUTER });
      expect(chain.root()).toBe(computeRoot([7n]));
    });

    it('denies a blocklisted depositor who goes through the router', async () => {
      const chain = fakeChain();
      chain.forwarded(7n, ROUTER, EVIL);
      chain.deposit(8n, '0xaa');
      const state = fresh();
      await runCycle(ctx(chain, state, [EVIL]));
      expect(statusOf(state, '7')).toMatchObject({ status: 'denied', depositor: EVIL, via: ROUTER });
      expect(statusOf(state, '7').reason).toMatch(/block list/);
      expect(chain.root()).toBe(computeRoot([8n]));
    });

    it('denies a blocklisted depositor who goes through the recycler', async () => {
      const chain = fakeChain();
      chain.forwarded(7n, RECYCLER, EVIL, 'Recycled');
      const state = fresh();
      await runCycle(ctx(chain, state, [EVIL]));
      expect(statusOf(state, '7')).toMatchObject({ status: 'denied', depositor: EVIL, via: RECYCLER });
    });

    it('revokes an approval when the real depositor is blocklisted later', async () => {
      const chain = fakeChain();
      chain.forwarded(7n, ROUTER, EVIL);
      const state = fresh();
      await runCycle(ctx(chain, state));
      expect(statusOf(state, '7').status).toBe('approved');
      await runCycle(ctx(chain, state, [EVIL]));
      expect(statusOf(state, '7').status).toBe('denied');
      expect(chain.root()).toBe(computeRoot([SENTINEL_LABEL]));
    });

    it("fails closed when the forwarder's event is missing or names another deposit", async () => {
      const chain = fakeChain();
      chain.forwarded(7n, ROUTER, SOMEONE, 'Deposited', 999n); // event for a different commitment
      const state = fresh();
      await runCycle(ctx(chain, state));
      expect(statusOf(state, '7')).toMatchObject({ status: 'denied', kind: 'unresolved' });
      expect(chain.published).toHaveLength(0);
    });

    it("denies a contract it doesn't trust that reports the deposit as made for someone else", async () => {
      const chain = fakeChain();
      chain.setCode(EVIL, '0x6001');
      chain.forwarded(7n, EVIL, SOMEONE); // an unknown contract claiming to forward for someone clean
      const state = fresh();
      await runCycle(ctx(chain, state));
      expect(statusOf(state, '7')).toMatchObject({ status: 'denied', kind: 'unknown-forwarder', depositor: EVIL });
      // An operator can allow it once it's known.
      const chain2 = fakeChain();
      chain2.setCode(EVIL, '0x6001');
      chain2.forwarded(7n, EVIL, SOMEONE);
      const state2 = fresh();
      await runCycle(ctx(chain2, state2, [], [EVIL]));
      expect(statusOf(state2, '7').status).toBe('approved');
    });

    it('approves a Safe depositing directly, screened as itself', async () => {
      const chain = fakeChain();
      chain.deposit(7n, WALLET, undefined, true); // with the Safe's own ExecutionSuccess event
      const state = fresh();
      await runCycle(ctx(chain, state));
      expect(statusOf(state, '7')).toMatchObject({ status: 'approved', kind: 'contract', depositor: WALLET });
    });

    it('denies a blocklisted Safe', async () => {
      const chain = fakeChain();
      chain.deposit(7n, WALLET, undefined, true);
      const state = fresh();
      await runCycle(ctx(chain, state, [WALLET]));
      expect(statusOf(state, '7')).toMatchObject({ status: 'denied', kind: 'contract', depositor: WALLET });
    });

    it('screens a Safe that deposits through the router as the Safe', async () => {
      const chain = fakeChain();
      chain.forwarded(7n, ROUTER, WALLET);
      chain.forwarded(8n, ROUTER, EVIL);
      chain.setCode(EVIL, '0x6001');
      const state = fresh();
      await runCycle(ctx(chain, state, [EVIL]));
      expect(statusOf(state, '7')).toMatchObject({ status: 'approved', kind: 'forwarded', depositor: WALLET, via: ROUTER });
      expect(statusOf(state, '8')).toMatchObject({ status: 'denied', depositor: EVIL, via: ROUTER });
    });

    it('treats an EIP-7702 delegated account as an ordinary account', async () => {
      const chain = fakeChain();
      chain.setCode(SOMEONE, `0xef0100${'11'.repeat(20)}`);
      chain.deposit(7n, SOMEONE);
      const state = fresh();
      await runCycle(ctx(chain, state));
      expect(statusOf(state, '7')).toMatchObject({ status: 'approved', kind: 'eoa' });
    });

    it('re-classifies records saved before this was tracked', async () => {
      const chain = fakeChain();
      chain.forwarded(7n, RECYCLER, EVIL, 'Recycled');
      const state = fresh();
      // As an older version would have saved it: approved, with the recycler as depositor.
      state.deposits.push({ pool: POOL, label: '7', depositor: RECYCLER, value: '1', commitment: '70', blockNumber: 100, logIndex: 0, txHash: `0x${(7).toString(16).padStart(64, '0')}`, timestamp: 1_000, status: 'approved' });
      state.lastScannedBlock = 200;
      chain.advance(150n);
      await runCycle(ctx(chain, state, [EVIL]));
      expect(statusOf(state, '7')).toMatchObject({ status: 'denied', depositor: EVIL, via: RECYCLER });
    });
  });
});
