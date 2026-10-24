/**
 * Yield pool prototype, end to end with real zero-knowledge proofs, on a local fork of Robinhood Chain
 * mainnet with the real USDG and the real Steakhouse USDG Morpho vault (see docs/yield-pool-design.md).
 *
 * The audited pool is deployed unchanged over SodiYieldVault shares, which only exist inside it. An
 * owner deposits through the router, the approval service approves, interest accrues for 30 days, then
 * two sessions are funded through SodiSessionFunder from real Groth16 proofs: USDG lands at a fresh
 * address, the relayer is paid, and the protocol fee streams into the share price. Finally what's left
 * in a session is recycled into the yield pool with the unchanged rx402 recycle code.
 *
 * Run with test/e2e-mainnet/run-fork.sh.
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Abi,
  type Address,
  type Hex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer as startAsp } from '../../../../asp/src/server.js';
import { runCycle } from '../../../../asp/src/service.js';
import type { ServiceState } from '../../../../asp/src/state.js';
import { MemoryStore, PoolWallet, RagequitProver, USDG_DOMAIN, WalletRecycleSubmitter, WalletRelayer, WithdrawalProver, aspAssociationSet, recycleFrom } from '../../src/index.js';

import { PROTOCOL_FEE_BPS, RPC, STEAK, USDG, chain, deployYieldStack, erc20, fundUsdg, publicClient, send as sendAs, testClient, usdgOf as usdgOfAddr, wallet } from './stack.js';

const RELAY_FEE_BPS = 20n;
PROTOCOL_FEE_BPS;
STEAK;
// anvil's default accounts
const deployer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const postman = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const relayer = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');

const vaultAbi = parseAbi([
  'function wire(address,address,address,address,uint256)',
  'function lockedRemaining() view returns (uint256)',
  'function deposit(uint256,address) returns (uint256)',
  'function convertToAssets(uint256) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
const routerAbi = parseAbi([
  'function deposit(uint256 assets, uint256 precommitment) returns (uint256)',
  'struct RagequitProof { uint256[2] pA; uint256[2][2] pB; uint256[2] pC; uint256[4] pubSignals; }',
  'function ragequit(RagequitProof proof)',
]);
const blocked = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a');

const send = (account: ReturnType<typeof privateKeyToAccount>, to: Address, abi: Abi, functionName: string, args: unknown[]) => sendAs(account, to, abi, functionName, args);
const usdgOf = usdgOfAddr;

describe('yield pool prototype with real proofs on a mainnet fork', () => {
  let vault: Address;
  let entrypoint: Address;
  let pool: Address;
  let funder: Address;
  let router: Address;
  let deployBlock: bigint;
  let poolWallet: PoolWallet;
  let ownerShares: bigint;
  let lastSession: Address;
  const store = new MemoryStore();
  const aspDir = join(tmpdir(), `sodi-yield-asp-${Date.now()}`);
  let aspState: ServiceState;
  let asp: ReturnType<typeof startAsp>;

  const approve = () =>
    runCycle({
      publicClient: publicClient as never,
      walletClient: wallet(postman) as never,
      entrypoint,
      pools: [pool],
      forwarders: [router], // every deposit comes through the router; screen the real depositor
      policy: { blockedAddresses: new Set([blocked.address.toLowerCase()]), deniedLabels: new Set(), vettingDelaySeconds: 0 },
      state: aspState,
      stateFile: join(aspDir, 'state.json'),
      setsDir: join(aspDir, 'sets'),
      logChunkSize: 5_000,
      dryRun: false,
    });

  /** A session through the SDK: PoolWallet sizes the withdrawal in shares with its margin; the relayer submits it to the funder. */
  async function openSession(usdg: bigint): Promise<{ session: Address; shares: bigint; tx: Hex }> {
    const session = privateKeyToAccount(generatePrivateKey()).address;
    const before = BigInt(store.load().notes[0]!.value);
    const funding = await poolWallet.fund(usdg, session);
    expect(funding.received).toBe(usdg);
    return { session, shares: before - BigInt(store.load().notes[0]!.value), tx: funding.fundingTx };
  }

  beforeAll(async () => {
    // The audited Privacy Pools stack, unchanged, with SodiYieldVault shares as the pool asset.
    await fundUsdg([[deployer.address, 1_000_000n], [owner.address, 1_000_000_000n], [blocked.address, 50_000_000n]]);
    ({ entrypoint, pool, vault, router, funder, deployBlock } = await deployYieldStack(deployer, postman.address));

    aspState = { chainId: 4663, entrypoint: entrypoint.toLowerCase(), lastScannedBlock: Number(deployBlock) - 1, deposits: [], published: [] };
    asp = startAsp(18432, () => aspState, join(aspDir, 'sets'));

    poolWallet = new PoolWallet({
      publicClient: publicClient as never,
      ownerWallet: wallet(owner),
      mnemonic: 'test test test test test test test test test test test junk',
      entrypoint,
      pool,
      asset: USDG,
      yieldPool: { vault, router, funder }, // the pool's asset is the yield vault's share; USDG in and out
      poolDeploymentBlock: deployBlock,
      relayer: new WalletRelayer(wallet(relayer), publicClient as never, entrypoint, RELAY_FEE_BPS, relayer.address, funder),
      prover: new WithdrawalProver(),
      associationSet: aspAssociationSet('http://127.0.0.1:18432'),
      store,
    });
  }, 300_000);

  afterAll(() => asp?.close());

  it('an owner deposits 1000 USDG through the router; the shares only ever exist in the pool', async () => {
    const precommitment = await poolWallet.reservePrecommitment();
    await send(owner, USDG, erc20, 'approve', [router, 1_000_000_000n]);
    await send(owner, router, routerAbi, 'deposit', [1_000_000_000n, precommitment]);
    await poolWallet.sync(); // finds the deposit by its precommitment
    const note = store.load().notes[0]!;
    ownerShares = BigInt(note.value);
    expect(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'balanceOf', args: [pool] })).toBe(ownerShares);
    expect(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'balanceOf', args: [owner.address] })).toBe(0n);
    await approve();
    // The approval service screened the owner, not the router.
    expect(aspState.deposits[0]).toMatchObject({ status: 'approved', kind: 'forwarded', depositor: owner.address.toLowerCase(), via: router.toLowerCase() });
  }, 300_000);

  it('denies a blocklisted depositor who goes through the router', async () => {
    await send(blocked, USDG, erc20, 'approve', [router, 50_000_000n]);
    await send(blocked, router, routerAbi, 'deposit', [50_000_000n, 424242n]);
    await approve();
    const d = aspState.deposits.find((x) => x.depositor === blocked.address.toLowerCase())!;
    expect(d).toMatchObject({ status: 'denied', kind: 'forwarded', via: router.toLowerCase() });
    expect(aspState.deposits.filter((x) => x.status === 'approved')).toHaveLength(1);
  }, 300_000);

  it('earns Morpho interest while it sits in the pool, with no transaction', async () => {
    const before = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'convertToAssets', args: [ownerShares] });
    await testClient.increaseTime({ seconds: 30 * 86_400 });
    await testClient.mine({ blocks: 1 });
    const after = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'convertToAssets', args: [ownerShares] });
    console.log(`   1000 USDG in the pool: ${Number(before) / 1e6} -> ${Number(after) / 1e6} USDG after 30 days`);
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBeLessThan(10_000_000n);
  }, 60_000);

  it('funds a USDG session from a real proof, through the session funder', async () => {
    // The fresh ASP root must be the latest when the proof lands.
    await approve();
    const priceBefore = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'convertToAssets', args: [1_000_000n] });
    const relayerBefore = await usdgOf(relayer.address);
    const { session, shares, tx } = await openSession(10_000_000n);
    lastSession = session;

    const received = await usdgOf(session);
    console.log(`   session ${session} received ${Number(received) / 1e6} USDG for ${Number(shares) / 1e6} shares`);
    expect(received).toBe(10_000_000n); // exactly, whatever the share price did
    expect((await usdgOf(relayer.address)) - relayerBefore).toBeGreaterThan(0n);
    // Submitted by the relayer; the session never held gas.
    const t = await publicClient.getTransaction({ hash: tx });
    console.log(`   gas for the session funding transaction: ${(await publicClient.getTransactionReceipt({ hash: tx })).gasUsed}`);
    expect(t.from.toLowerCase()).toBe(relayer.address.toLowerCase());
    expect(await publicClient.getBalance({ address: session })).toBe(0n);
    // The change stays in the pool as a share commitment of the owner's.
    expect(BigInt(store.load().notes[0]!.value)).toBe(ownerShares - shares);
    expect(store.load().notes[0]!.spendCount).toBe(1);
    // The protocol fee streams to everyone still in the pool over the next seven days.
    expect(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'lockedRemaining' })).toBeGreaterThan(0n);
    await testClient.increaseTime({ seconds: 7 * 86_400 });
    await testClient.mine({ blocks: 1 });
    const priceAfter = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'convertToAssets', args: [1_000_000n] });
    expect(priceAfter).toBeGreaterThan(priceBefore);
  }, 600_000);

  it('funds a second session from the change commitment', async () => {
    await approve();
    const { session } = await openSession(5_000_000n);
    expect(await usdgOf(session)).toBe(5_000_000n);
    expect(store.load().notes[0]!.spendCount).toBe(2);
  }, 600_000);

  it('recycles what is left in a session into the yield pool, gaslessly, with the unchanged rx402 code', async () => {
    // Move the last session's balance to a key we hold (on the fork), as if it had finished.
    const key = generatePrivateKey();
    const sessionAccount = privateKeyToAccount(key);
    await testClient.impersonateAccount({ address: lastSession });
    await testClient.setBalance({ address: lastSession, value: 10n ** 18n });
    const left = await usdgOf(lastSession);
    await publicClient.waitForTransactionReceipt({
      hash: await createWalletClient({ chain, account: lastSession, transport: http(RPC) }).writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [sessionAccount.address, left] }),
    });
    const before = store.load().notes.length;
    const precommitment = await poolWallet.reservePrecommitment();
    const tx = await recycleFrom(sessionAccount, {
      publicClient: publicClient as never,
      asset: USDG,
      domain: USDG_DOMAIN,
      submitter: new WalletRecycleSubmitter(wallet(relayer), publicClient as never, router), // the router speaks the recycler's interface
      value: left,
      precommitment,
      now: Number((await publicClient.getBlock()).timestamp),
    });
    expect(await usdgOf(sessionAccount.address)).toBe(0n);
    expect(await publicClient.getBalance({ address: sessionAccount.address })).toBe(0n);
    await poolWallet.sync();
    expect(store.load().notes).toHaveLength(before + 1);
    console.log(`   recycled ${Number(left) / 1e6} USDG into the yield pool in ${tx}`);
  }, 300_000);

  it("ragequits what's left of the deposit through the router, with a real proof, back to the owner in USDG", async () => {
    const note = store.load().notes[0]!;
    const left = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'convertToAssets', args: [BigInt(note.value)] });
    const before = await usdgOf(owner.address);
    const proof = await poolWallet.ragequitProof(note.label, new RagequitProver());
    // Anyone may submit it (here the relayer); the USDG can only go to the depositor.
    await send(relayer, router, routerAbi, 'ragequit', [
      {
        pA: proof.pA.map(BigInt),
        pB: proof.pB.map((r) => r.map(BigInt)),
        pC: proof.pC.map(BigInt),
        pubSignals: proof.pubSignals.map(BigInt),
      },
    ]);
    const got = (await usdgOf(owner.address)) - before;
    console.log(`   ragequit returned ${Number(got) / 1e6} USDG to the owner (the note was worth ${Number(left) / 1e6})`);
    expect(got).toBeGreaterThanOrEqual(left - 2n);
    await poolWallet.sync();
    expect(store.load().notes[0]).toMatchObject({ value: '0', ragequitTx: expect.any(String) });
  }, 300_000);
});
