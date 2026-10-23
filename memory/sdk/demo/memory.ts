/**
 * Encrypted agent memory, anchored on-chain.
 *
 *   Sage, a trading agent with no gas, keeps its notes in Sodi Memory. It restarts and recovers them,
 *   survives a second copy of itself writing at the same time, catches a tampered blob store, hands a
 *   note to a teammate, and rotates its key. Eve watches the chain and learns nothing useful.
 */
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { A2AClient, WalletPostRelayer } from '@sodi/a2a';
import { type Address, type Hex, type PublicClient, type WalletClient } from 'viem';

import { memoryCommittedEvent } from '../src/abi.js';
import { FileBlobStore } from '../src/blobs.js';
import { AgentMemory, VersionConflictError, WalletMemoryRelayer } from '../src/memory.js';
import { publicNamespace } from '../src/keys.js';

export async function runDemo(opts: {
  publicClient: PublicClient;
  relayerWallet: WalletClient;
  sage: WalletClient;
  juno: WalletClient;
  memoryContract: Address;
  registry: Address;
  fromBlock: bigint;
  log?: (m: string) => void;
}) {
  const log = opts.log ?? console.log;
  const { publicClient, memoryContract, fromBlock } = opts;
  const relayer = new WalletMemoryRelayer(opts.relayerWallet, publicClient, memoryContract);
  const blobDir = mkdtempSync(join(tmpdir(), 'sodi-memory-'));
  const blobs = new FileBlobStore(blobDir);
  const make = (epoch = 1) =>
    new AgentMemory({ publicClient, wallet: opts.sage, contract: memoryContract, fromBlock, relayer, blobs, epoch });
  const results: Record<string, unknown> = {};

  log('1. Sage writes two memories (gasless): a small one on-chain, a large one in a blob store');
  const sage = make();
  await sage.init();
  const portfolio = { positions: [{ symbol: 'NVDA', size: 12 }, { symbol: 'TSLA', size: -4 }], thesis: 'AI capex cycle' };
  const w1 = await sage.set('portfolio', portfolio);
  const research = { notes: 'x'.repeat(6000), sources: 14 };
  const w2 = await sage.set('research', research);
  log(`   portfolio v${w1.version} (${w1.inline ? 'inline on-chain' : 'blob'}), research v${w2.version} (${w2.inline ? 'inline' : 'blob store, hash on-chain'})`);

  log('2. Sage restarts with nothing but its wallet, and recovers everything');
  const restarted = make();
  await restarted.init();
  const got = await restarted.get<typeof portfolio>('portfolio');
  const gotResearch = await restarted.get<typeof research>('research');
  results.recovered = JSON.stringify(got?.value) === JSON.stringify(portfolio) && gotResearch?.value.sources === 14;
  log(`   recovered: ${results.recovered ? 'yes' : 'NO'}`);

  log('3. Two copies of Sage write at once; the stale one is stopped, then retries cleanly');
  const copyA = make();
  const copyB = make();
  await Promise.all([copyA.init(), copyB.init()]);
  const base = (await copyA.get<typeof portfolio>('portfolio'))!;
  await copyA.set('portfolio', { ...base.value, thesis: 'AI capex cycle, trimming TSLA' }, { expectedVersion: base.version });
  try {
    await copyB.set('portfolio', { ...base.value, thesis: 'stale view' }, { expectedVersion: base.version });
    results.conflictCaught = false;
  } catch (err) {
    results.conflictCaught = err instanceof VersionConflictError;
  }
  const merged = await copyB.update<typeof portfolio>('portfolio', (cur) => ({ ...cur!, positions: [...cur!.positions, { symbol: 'AAPL', size: 3 }] }));
  log(`   stale write ${results.conflictCaught ? 'rejected' : 'NOT rejected'}; retry landed as v${merged.version} keeping both changes`);
  results.mergedKeepsBoth = merged.value.thesis.includes('trimming') && merged.value.positions.length === 3;

  log('4. The blob store is tampered with; Sage notices');
  const file = join(blobDir, readdirSync(blobDir)[0]!);
  const original = (await blobs.get(`file://${readdirSync(blobDir)[0]}`));
  const forged = original.slice();
  forged[forged.length - 1]! ^= 1;
  writeFileSync(file, forged);
  try {
    await restarted.get('research');
    results.tamperCaught = false;
  } catch (err) {
    results.tamperCaught = /integrity/.test(String(err));
  }
  writeFileSync(file, original);
  log(`   tampering ${results.tamperCaught ? 'detected' : 'NOT detected'}`);

  log('5. Sage hands a note to its teammate Juno, readable by the two of them only');
  const juno = new A2AClient({ publicClient, wallet: opts.juno, contract: opts.registry, relayer: new WalletPostRelayer(opts.relayerWallet, publicClient, opts.registry) });
  await juno.init();
  await juno.register();
  const handoff = { id: publicNamespace(`handoff:${Date.now()}`) };
  await sage.set(handoff, { task: 'Rebalance at 15:30 ET', maxSlippageBps: 20 }, { shareWith: [await juno.keyOf(juno.address)] });
  const junoReads = await sage.readShared<{ task: string }>(sage.address, handoff.id!, juno.keyPair);
  results.teammateReads = junoReads?.value.task === 'Rebalance at 15:30 ET';
  log(`   Juno reads it: ${results.teammateReads ? 'yes' : 'no'}`);

  log('6. What Eve sees on-chain');
  const logs = await publicClient.getLogs({ address: memoryContract, event: memoryCommittedEvent, args: { agent: sage.address }, fromBlock });
  for (const l of logs) {
    const where = l.args.envelope === '0x' ? `pointer ${l.args.location!.slice(0, 18)}…` : `${(l.args.envelope!.length - 2) / 2}-byte ciphertext`;
    log(`   slot ${l.args.namespace!.slice(0, 12)}… v${l.args.version}  ${where}`);
  }
  results.eveCanRead = (await sage.readShared(sage.address, handoff.id!, { privateKey: new Uint8Array(32).fill(7), publicKey: '0x00' as Hex }).catch(() => undefined)) !== undefined;

  log('7. Sage rotates to a new key; current memory moves over, history stays readable');
  const rotated = await sage.rotate(['portfolio', 'research'], 2);
  const after = await rotated.get<typeof portfolio>('portfolio');
  const history = await rotated.history<typeof portfolio>('portfolio');
  results.rotated = after?.epoch === 2 && history.some((h) => h.epoch === 1);
  log(`   portfolio now v${after?.version} under epoch ${after?.epoch}; ${history.length} versions in history`);

  results.transactions = logs.length;
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { createPublicClient, createWalletClient, defineChain, http } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const rpcUrl = process.env.RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';
  const need = (n: string) => {
    if (!process.env[n]) throw new Error(`set ${n}`);
    return process.env[n] as Hex;
  };
  const p0 = createPublicClient({ transport: http(rpcUrl) });
  const chain = defineChain({ id: await p0.getChainId(), name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const w = (k: Hex) => createWalletClient({ chain, account: privateKeyToAccount(k), transport: http(rpcUrl) });
  const { generatePrivateKey } = await import('viem/accounts');
  const r = await runDemo({
    publicClient: createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient,
    relayerWallet: w(need('RELAYER_PRIVATE_KEY')),
    sage: w((process.env.SAGE_PRIVATE_KEY as Hex) ?? generatePrivateKey()),
    juno: w(generatePrivateKey()),
    memoryContract: need('MEMORY_CONTRACT') as Address,
    registry: need('REGISTRY') as Address,
    fromBlock: BigInt(need('FROM_BLOCK')),
  });
  console.log('\n', JSON.stringify(r));
}
