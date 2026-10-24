import { open } from '@sodi/a2a';
import { type Hex, hexToBytes, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { deriveMemoryKey } from '../../src/keys.js';
import { AgentMemory } from '../../src/memory.js';

const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const CONTRACT = '0x5792659446E32eF320Dd19b42cc27a3737ac710e' as const;

/** SodiMemory in memory: compare-and-swap heads and MemoryCommitted logs. */
function fakeMemoryContract() {
  const heads = new Map<string, { version: bigint; contentHash: Hex }>();
  const logs: { args: Record<string, unknown> }[] = [];
  const wallet = {
    account,
    chain: undefined,
    signMessage: ({ message }: { message: string }) => account.signMessage({ message }),
    writeContract: async ({ args }: { args: [Hex, bigint, Hex] }) => {
      const [ns, expected, envelope] = args;
      const h = heads.get(ns) ?? { version: 0n, contentHash: '0x' };
      if (h.version !== expected) throw new Error('VersionConflict');
      const version = expected + 1n;
      heads.set(ns, { version, contentHash: keccak256(envelope) });
      logs.push({ args: { agent: account.address, namespace: ns, version, contentHash: keccak256(envelope), envelope, location: '' } });
      return '0x01';
    },
  };
  const publicClient = {
    getChainId: async () => 46630,
    waitForTransactionReceipt: async () => ({ status: 'success' }),
    readContract: async ({ args }: { args: [string, Hex] }) => {
      const h = heads.get(args[1]) ?? { version: 0n, contentHash: `0x${'00'.repeat(32)}` };
      return [h.version, h.contentHash];
    },
    getLogs: async ({ args }: { args: { namespace?: Hex } }) => logs.filter((l) => !args.namespace || l.args.namespace === args.namespace),
  };
  return { config: { publicClient, wallet, contract: CONTRACT, fromBlock: 0n } as never, logs };
}

describe('key epochs (review fixes)', () => {
  it('a restarted agent finds its current epoch, and retired keys stay retired', async () => {
    const { config, logs } = fakeMemoryContract();
    const m = new AgentMemory(config);
    await m.init();
    await m.set('portfolio', { cash: 1 });
    const rotated = await m.rotate(['portfolio'], 2);
    expect(rotated.epoch).toBe(2);

    const restarted = new AgentMemory(config);
    await restarted.init();
    expect(restarted.epoch).toBe(2);
    expect((await restarted.get<{ cash: number }>('portfolio'))?.value).toEqual({ cash: 1 });
    await restarted.set('portfolio', { cash: 999 });

    const retired = await deriveMemoryKey(config['wallet' as never], 1);
    const last = logs.at(-1)!.args;
    const ctx = { chainId: 46630, contract: CONTRACT, channelId: BigInt(last.namespace as Hex), author: account.address };
    expect(open(hexToBytes(last.envelope as Hex), retired, ctx)).toBeNull();
  });

  it('refuses to overwrite a version it cannot read', async () => {
    const { config } = fakeMemoryContract();
    const m = new AgentMemory(config);
    await m.init();
    await m.set('portfolio', { cash: 1 });
    await m.rotate(['portfolio'], 2);
    const stale = new AgentMemory({ ...(config as object), epoch: 1 } as never);
    await stale.init();
    await expect(stale.set('portfolio', { cash: 0 })).rejects.toThrow(/newer key epoch/);
  });
});
