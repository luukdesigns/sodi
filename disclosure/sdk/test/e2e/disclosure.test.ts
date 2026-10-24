/**
 * Sodi Disclosure end to end on a local fork of Robinhood Chain testnet.
 *
 * An owner agent has private activity everywhere in Sodi: two A2A threads, two memory slots, an ERC-8183
 * job and two rx402 deposits. It discloses exactly one thread, one slot, the job and one deposit to an
 * auditor, then grants and revokes standing access. The auditor verifies everything against the chain.
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { A2AClient, WalletPostRelayer } from '@sodi/a2a';
import { AgentMemory, WalletMemoryRelayer } from '@sodi/memory';
import { MemoryStore, Rx402Client, WalletRelayer, WithdrawalProver } from '@sodi/rx402';
import {
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';

import { approvedLabels } from '../../../../asp/src/screening.js';
import { runCycle } from '../../../../asp/src/service.js';
import type { ServiceState } from '../../../../asp/src/state.js';
import { deploy as deploy8183 } from '../../../../erc8183/sdk/demo/audit-job.js';
import { PrivateJobs } from '../../../../erc8183/sdk/src/client.js';
import { Auditor, Discloser, StandingGrants, disclosePoolNote, memoryScope } from '../../src/index.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const POSTMAN_KEY = process.env.POSTMAN_PRIVATE_KEY as Hex;
const WHALE = '0xf0d65776d3ce5f4b6f5e6043326cee858df55506' as Address;
const chain = defineChain({ id: 46630, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const publicClient = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
const wallet = (k: Hex) => createWalletClient({ chain, account: privateKeyToAccount(k), transport: http(RPC) });
const artifact = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const poolDeployment = artifact('../../../../contracts/deployments/46630.json');

const owner = wallet('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
const provider = wallet('0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e');
const evaluator = wallet('0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356');
const relayer = wallet('0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97');
const [bob, carol, auditorW, mallory] = [0, 1, 2, 3].map(() => wallet(generatePrivateKey()));

describe('Sodi Disclosure', () => {
  let fromBlock: bigint;
  let registry: Address;
  let memoryContract: Address;
  let hook: Address;
  let jobId: bigint;
  const ids = {} as Record<string, A2AClient>;
  let ownerMemory: AgentMemory;
  let discloser: Discloser;
  let auditor: Auditor;
  let rx: Rx402Client;
  const rxStore = new MemoryStore();

  const deployed = async (p: string) => {
    const a = artifact(p);
    const hash = await relayer.deployContract({ abi: a.abi, bytecode: a.bytecode.object });
    return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  const identity = async (name: string, w: ReturnType<typeof wallet>) => {
    const c = new A2AClient({ publicClient, wallet: w, contract: registry, relayer: new WalletPostRelayer(relayer, publicClient, registry) });
    await c.init();
    await c.register();
    ids[name] = c;
    return c;
  };

  beforeAll(async () => {
    expect(POSTMAN_KEY, 'set POSTMAN_PRIVATE_KEY').toBeTruthy();
    fromBlock = await publicClient.getBlockNumber();
    registry = await deployed('../../../../a2a/contracts/out/SodiA2A.sol/SodiA2A.json');
    memoryContract = await deployed('../../../../memory/contracts/out/SodiMemory.sol/SodiMemory.json');
    for (const [n, w] of [['owner', owner], ['provider', provider], ['evaluator', evaluator], ['bob', bob], ['carol', carol], ['auditor', auditorW], ['mallory', mallory]] as const) {
      await identity(n, w);
    }

    // --- Owner's private activity -------------------------------------------------------------
    // Two A2A threads on the open channel.
    await ids.owner!.send({ to: [bob.account.address], type: 'deal', body: { with: 'bob', text: 'Offer: 100 GPU-hours at 0.45' } });
    await ids.bob!.send({ to: [owner.account.address], type: 'deal', body: { with: 'owner', text: 'Accepted' } });
    await ids.owner!.send({ to: [carol.account.address], type: 'chat', body: { with: 'carol', text: 'Personal: dinner Friday?' } });

    // Two memory slots.
    ownerMemory = new AgentMemory({ publicClient, wallet: owner, contract: memoryContract, fromBlock, relayer: new WalletMemoryRelayer(relayer, publicClient, memoryContract) });
    await ownerMemory.init();
    await ownerMemory.set('trades', [{ id: 1, side: 'buy', symbol: 'NVDA', qty: 10 }]);
    await ownerMemory.update('trades', (t: unknown[] | undefined) => [...(t ?? []), { id: 2, side: 'sell', symbol: 'TSLA', qty: 4 }]);
    await ownerMemory.set('personal', { note: 'not for auditors' });

    // An ERC-8183 job with a confidential deliverable and review.
    const d = await deploy8183(publicClient, relayer, registry);
    hook = d.hook;
    const mint = parseAbi(['function mint(address,uint256)']);
    await publicClient.waitForTransactionReceipt({ hash: await relayer.writeContract({ address: d.token, abi: mint, functionName: 'mint', args: [owner.account.address, 10_000_000n] }) });
    const jobs = (w: ReturnType<typeof wallet>, n: string) => new PrivateJobs({ publicClient, wallet: w, commerce: d.commerce, hook: d.hook, identity: ids[n]! });
    ({ jobId } = await jobs(owner, 'owner').createJob({ provider: provider.account.address, evaluator: evaluator.account.address, expiresInSeconds: 86_400, description: 'Quarterly reconciliation' }));
    await jobs(provider, 'provider').setBudget(jobId, 10_000_000n);
    await jobs(owner, 'owner').fund(jobId);
    await jobs(provider, 'provider').submitConfidential(jobId, { reconciled: true, discrepancies: 0 });
    await jobs(evaluator, 'evaluator').complete(jobId, { verdict: 'Checks out' }, { fromBlock });

    // Two rx402 deposits; one funds a session.
    const test = createTestClient({ chain, mode: 'anvil', transport: http(RPC) });
    await test.impersonateAccount({ address: WHALE });
    await test.setBalance({ address: WHALE, value: 10n ** 18n });
    const erc20 = parseAbi(['function transfer(address,uint256) returns (bool)']);
    const whale = createWalletClient({ chain, account: WHALE, transport: http(RPC) });
    await publicClient.waitForTransactionReceipt({ hash: await whale.writeContract({ address: poolDeployment.pools.USDG.asset, abi: erc20, functionName: 'transfer', args: [owner.account.address, 4_000_000n] }) });
    rx = new Rx402Client({
      publicClient,
      ownerWallet: owner,
      mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
      entrypoint: poolDeployment.contracts.Entrypoint,
      pool: poolDeployment.pools.USDG.pool,
      asset: poolDeployment.pools.USDG.asset,
      poolDeploymentBlock: BigInt(poolDeployment.deploymentBlock),
      relayer: new WalletRelayer(relayer, publicClient, poolDeployment.contracts.Entrypoint),
      prover: new WithdrawalProver(),
      associationSet: async () => approvedLabels(aspState.deposits),
      store: rxStore,
      policy: { budget: 1_000_000n, maxPayments: 10, maxAgeSeconds: 3600, maxPaymentAmount: 100_000n },
    });
    const aspState: ServiceState = { chainId: 46630, entrypoint: poolDeployment.contracts.Entrypoint.toLowerCase(), lastScannedBlock: poolDeployment.deploymentBlock - 1, deposits: [], published: [] };
    await rx.deposit(2_000_000n);
    await rx.deposit(2_000_000n);
    await runCycle({ publicClient, walletClient: wallet(POSTMAN_KEY), entrypoint: poolDeployment.contracts.Entrypoint, pools: [poolDeployment.pools.USDG.pool], policy: { blockedAddresses: new Set(), deniedLabels: new Set(), vettingDelaySeconds: 0 }, state: aspState, stateFile: join(tmpdir(), `asp-${Date.now()}.json`), setsDir: join(tmpdir(), `sets-${Date.now()}`), logChunkSize: 50_000, dryRun: false });
    await rx.openSession(1_000_000n);

    discloser = new Discloser(publicClient, ids.owner!);
    // This test deploys its own A2A, memory and job contracts, so the auditor is told to trust them.
    auditor = new Auditor(publicClient, ids.auditor!, undefined, {
      a2a: [registry],
      memory: [memoryContract],
      erc8183Hooks: [hook],
      pools: [{ pool: poolDeployment.pools.USDG.pool, entrypoint: poolDeployment.contracts.Entrypoint }],
    });
  }, 600_000);

  it('discloses exactly the chosen items, and the auditor verifies them on-chain', async () => {
    const items = [
      ...(await discloser.collectMessages({ contract: registry, channelId: 0n, fromBlock, filter: (m) => (m.body as { with: string }).with !== 'carol' })),
      ...(await discloser.collectMemory(ownerMemory, memoryContract, 'trades')),
      ...(await discloser.collectJob({ hook, jobId, fromBlock })),
    ];
    const note = rxStore.load().notes.find((n) => n.spendCount > 0)!;
    const pool = [await disclosePoolNote({ publicClient, mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', pool: poolDeployment.pools.USDG.pool, entrypoint: poolDeployment.contracts.Entrypoint, note })];
    await discloser.send({ auditor: auditorW.account.address, note: 'Q4 review: Bob deal, trade log, reconciliation job, deposit 1', items, pool });

    const [grant] = await auditor.grants(fromBlock);
    expect(grant!.from).toBe(owner.account.address);
    const { records, failures } = await auditor.readGrant(grant!);
    expect(failures).toEqual([]);

    const texts = JSON.stringify(records.map((r) => r.data));
    expect(records.filter((r) => r.kind === 'a2a')).toHaveLength(2);
    expect(records.filter((r) => r.kind === 'memory')).toHaveLength(2);
    expect(records.map((r) => r.kind)).toEqual(expect.arrayContaining(['erc8183-deliverable', 'erc8183-review']));
    expect(texts).toContain('Accepted');
    expect(texts).toContain('TSLA');
    expect(texts).toContain('discrepancies');
    // Nothing outside the scope leaks.
    expect(texts).not.toContain('dinner');
    expect(texts).not.toContain('not for auditors');
    // Authors come from the chain: Bob's reply is attributed to Bob.
    expect(records.find((r) => JSON.stringify(r.data).includes('Accepted'))!.author).toBe(bob.account.address);

    const [history] = await auditor.verifyPool(grant!, BigInt(poolDeployment.deploymentBlock));
    expect(history!.depositor).toBe(owner.account.address);
    expect(history!.deposited).toBe(2_000_000n);
    expect(history!.sessions).toHaveLength(1);
    expect(history!.sessions[0]!.recipient).toBe(rxStore.load().sessions[0]!.address);
    expect(history!.remaining).toBe(1_000_000n);
  }, 300_000);

  it('rejects a key reused on an item outside the grant', async () => {
    const [grant] = await auditor.grants(fromBlock);
    const bobItem = grant!.items.find((i) => i.kind === 'a2a')!;
    const carolLog = (await publicClient.getContractEvents({ address: registry, abi: parseAbi(['event Posted(uint256 indexed channelId, address indexed author, bytes envelope)']), eventName: 'Posted', fromBlock }))[2]!;
    await expect(auditor.read({ ...bobItem, ref: `${carolLog.transactionHash}:${carolLog.logIndex}` })).rejects.toThrow(/does not open/);
  });

  it('ignores grants that claim to come from someone else', async () => {
    await ids.mallory!.send({ to: [auditorW.account.address], type: 'sodi-disclosure', body: { v: 1, owner: owner.account.address, issuedAt: 0, note: 'forged', items: [] } });
    const grants = await auditor.grants(fromBlock);
    expect(grants).toHaveLength(1);
    expect(grants.every((g) => g.from === owner.account.address)).toBe(true);
  });

  it('rejects a pool disclosure for someone else’s deposit', async () => {
    const [grant] = await auditor.grants(fromBlock);
    const forged = { ...grant!.pool![0]!, chain: [{ nullifier: '1', secret: '2' }] };
    await expect(auditor.verifyPool({ ...grant!, pool: [forged] }, BigInt(poolDeployment.deploymentBlock))).rejects.toThrow(/does not match/);
  });

  it('rejects items from contracts it does not trust (an owner could deploy one that says anything)', async () => {
    const [grant] = await auditor.grants(fromBlock);
    const item = grant!.items.find((i) => i.kind === 'a2a')!;
    await expect(auditor.read({ ...item, contract: mallory.account.address })).rejects.toThrow(/not a trusted a2a contract/);
    const p = grant!.pool![0]!;
    await expect(auditor.verifyPool({ ...grant!, pool: [{ ...p, pool: mallory.account.address }] }, 0n)).rejects.toThrow(/not a trusted pool/);
  });

  it('keeps working when strangers send it malformed grants or spoofed notices', async () => {
    for (const body of [null, {}, { owner: mallory.account.address }, { owner: mallory.account.address, items: 'x' }]) {
      await ids.mallory!.send({ to: [auditorW.account.address], type: 'sodi-disclosure', body });
    }
    await ids.mallory!.send({ to: [auditorW.account.address], type: 'sodi-standing-revoked', body: { scope: 'memory:0x1', from: owner.account.address } });
    expect(await auditor.grants(fromBlock)).toHaveLength(1);
    const spoof = (await auditor.standingNotices(fromBlock)).find((n) => n.scope === 'memory:0x1')!;
    expect(spoof.from).toBe(mallory.account.address);
  });

  it('rejects a pool disclosure that leaves out later withdrawals', async () => {
    const note = structuredClone(rxStore.load().notes.find((n) => n.spendCount > 0)!);
    await rx.openSession(500_000n); // the same deposit funds a second session
    const truncated = await disclosePoolNote({ publicClient, mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', pool: poolDeployment.pools.USDG.pool, entrypoint: poolDeployment.contracts.Entrypoint, note });
    const [grant] = await auditor.grants(fromBlock);
    await expect(auditor.verifyPool({ ...grant!, pool: [truncated] }, BigInt(poolDeployment.deploymentBlock))).rejects.toThrow(/incomplete/);
  }, 300_000);

  it('grants standing access to future writes, then revokes it', async () => {
    const standing = new StandingGrants(ownerMemory, ids.owner!);
    const tradesId = ownerMemory.slotId('trades');
    await standing.grant(auditorW.account.address, memoryScope(tradesId), 'ongoing trade log access');
    await ownerMemory.update('trades', (t: unknown[] | undefined) => [...(t ?? []), { id: 3 }]);
    // The write path asks the policy who else may read.
    const readers = await standing.readersFor(memoryScope(tradesId));
    const current = await ownerMemory.get<unknown[]>('trades');
    await ownerMemory.set('trades', [...current!.value, { id: 4 }], { shareWith: readers, expectedVersion: current!.version });

    await standing.revoke(auditorW.account.address, memoryScope(tradesId));
    const after = await ownerMemory.get<unknown[]>('trades');
    await ownerMemory.set('trades', [...after!.value, { id: 5 }], { shareWith: await standing.readersFor(memoryScope(tradesId)), expectedVersion: after!.version });

    const visible = await auditor.readStandingMemory(memoryContract, owner.account.address, tradesId, fromBlock);
    expect(visible.map((v) => v.version)).toEqual([4n]); // shared while granted; not before, not after revoke
    const notices = await auditor.standingNotices(fromBlock);
    expect(notices.filter((n) => n.from === owner.account.address).map((n) => n.type)).toEqual(['sodi-standing-grant', 'sodi-standing-revoked']);
  }, 300_000);
});
