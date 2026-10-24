/**
 * Yield pool prototype, end to end with real zero-knowledge proofs, on a local fork of Robinhood Chain
 * mainnet with the real USDG and the real Steakhouse USDG Morpho vault (see docs/yield-pool-design.md).
 *
 * The audited pool is deployed unchanged over SodiYieldVault shares. An owner deposits, the approval
 * service approves, interest accrues for 30 days, then two sessions are funded through
 * SodiSessionFunder from real Groth16 proofs: USDG lands at a fresh address, the relayer is paid, and
 * the protocol fee raises the share price for everyone still in the pool.
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
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseAbi,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer as startAsp } from '../../../../asp/src/server.js';
import { runCycle } from '../../../../asp/src/service.js';
import type { ServiceState } from '../../../../asp/src/state.js';
import { MemoryStore, PoolWallet, WithdrawalProver, aspAssociationSet } from '../../src/index.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;
const STEAK = '0xBeEff033F34C046626B8D0A041844C5d1A5409dd' as Address;
const PROTOCOL_FEE_BPS = 50n;
const RELAY_FEE_BPS = 20n;

const artifact = (file: string, name: string, libraries: Record<string, Address> = {}) => {
  const a = JSON.parse(readFileSync(new URL(`../../../../contracts/out/${file}/${name}.json`, import.meta.url), 'utf8'));
  let code = (a.bytecode.object as string).slice(2);
  // Link libraries (Foundry does this for scripts; a raw deploy has to).
  for (const refs of Object.values(a.bytecode.linkReferences ?? {}) as Record<string, { start: number; length: number }[]>[]) {
    for (const [lib, places] of Object.entries(refs)) {
      const address = libraries[lib];
      if (!address) throw new Error(`${name} needs library ${lib}`);
      for (const { start, length } of places) code = code.slice(0, start * 2) + address.slice(2).toLowerCase() + code.slice((start + length) * 2);
    }
  }
  return { abi: a.abi as Abi, bytecode: `0x${code}` as Hex };
};

const chain = defineChain({ id: 4663, name: 'Robinhood Chain (fork)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const testClient = createTestClient({ chain, mode: 'anvil', transport: http(RPC) });
const wallet = (account: ReturnType<typeof privateKeyToAccount>) => createWalletClient({ chain, account, transport: http(RPC) });
// anvil's default accounts
const deployer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const postman = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const relayer = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');

const erc20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const vaultAbi = parseAbi([
  'function deposit(uint256,address) returns (uint256)',
  'function convertToAssets(uint256) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
const funderAbi = parseAbi([
  'struct Withdrawal { address processooor; bytes data; }',
  'struct WithdrawProof { uint256[2] pA; uint256[2][2] pB; uint256[2] pC; uint256[8] pubSignals; }',
  'function fund(Withdrawal w, WithdrawProof proof)',
]);

async function deploy(a: { abi: Abi; bytecode: Hex }, args: unknown[] = []): Promise<Address> {
  const hash = await wallet(deployer).deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !r.contractAddress) throw new Error('deploy failed');
  return r.contractAddress;
}
async function send(account: ReturnType<typeof privateKeyToAccount>, to: Address, abi: Abi, functionName: string, args: unknown[]) {
  const hash = await wallet(account).writeContract({ address: to, abi, functionName, args } as never);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
  return r;
}
const usdgOf = (a: Address) => publicClient.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [a] });

describe('yield pool prototype with real proofs on a mainnet fork', () => {
  let vault: Address;
  let entrypoint: Address;
  let pool: Address;
  let funder: Address;
  let deployBlock: bigint;
  let poolWallet: PoolWallet;
  let ownerShares: bigint;
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
      policy: { blockedAddresses: new Set(), deniedLabels: new Set(), vettingDelaySeconds: 0 },
      state: aspState,
      stateFile: join(aspDir, 'state.json'),
      setsDir: join(aspDir, 'sets'),
      logChunkSize: 5_000,
      dryRun: false,
    });

  /** Proves a withdrawal of enough shares for `usdg` after fees, and has the relayer submit it to the funder. */
  async function openSession(usdg: bigint): Promise<{ session: Address; shares: bigint; tx: Hex }> {
    const session = privateKeyToAccount(generatePrivateKey()).address;
    const gross = (usdg * 10_000n + (10_000n - PROTOCOL_FEE_BPS - RELAY_FEE_BPS) - 1n) / (10_000n - PROTOCOL_FEE_BPS - RELAY_FEE_BPS);
    const shares = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'previewWithdraw', args: [gross] });
    const data = encodeAbiParameters(
      [{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }] }],
      [[session, relayer.address, RELAY_FEE_BPS, usdg]],
    );
    const tx = await poolWallet.withdrawVia(shares, funder, data, async (withdrawal, proof) => {
      const hash = await wallet(relayer).writeContract({
        address: funder,
        abi: funderAbi,
        functionName: 'fund',
        args: [
          withdrawal,
          {
            pA: proof.pA.map(BigInt) as [bigint, bigint],
            pB: proof.pB.map((r) => r.map(BigInt)) as [[bigint, bigint], [bigint, bigint]],
            pC: proof.pC.map(BigInt) as [bigint, bigint],
            pubSignals: proof.pubSignals.map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
          },
        ],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      return hash;
    });
    return { session, shares, tx };
  }

  beforeAll(async () => {
    // Deploy: the audited Privacy Pools stack, unchanged, with SodiYieldVault shares as the pool asset.
    const wv = await deploy(artifact('WithdrawalVerifier.sol', 'WithdrawalVerifier'));
    const rv = await deploy(artifact('CommitmentVerifier.sol', 'CommitmentVerifier'));
    const ep = artifact('Entrypoint.sol', 'Entrypoint');
    const impl = await deploy(ep);
    entrypoint = await deploy(artifact('ERC1967Proxy.sol', 'ERC1967Proxy'), [
      impl,
      encodeFunctionData({ abi: ep.abi, functionName: 'initialize', args: [deployer.address, postman.address] }),
    ]);
    vault = await deploy(artifact('SodiYieldVault.sol', 'SodiYieldVault'), [USDG, STEAK]);
    const libraries = {
      PoseidonT3: await deploy(artifact('PoseidonT3.sol', 'PoseidonT3')),
      PoseidonT4: await deploy(artifact('PoseidonT4.sol', 'PoseidonT4')),
    };
    pool = await deploy(artifact('PrivacyPoolComplex.sol', 'PrivacyPoolComplex', libraries), [entrypoint, wv, rv, vault]);
    deployBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
    await send(deployer, entrypoint, ep.abi, 'registerPool', [vault, pool, 1_000_000n, 0n, 100n]);
    funder = await deploy(artifact('SodiSessionFunder.sol', 'SodiSessionFunder'), [pool, vault, PROTOCOL_FEE_BPS]);

    // USDG for the test, from the Morpho vault's idle balance (fork only).
    await testClient.impersonateAccount({ address: STEAK });
    await testClient.setBalance({ address: STEAK, value: 10n ** 18n });
    const steak = createWalletClient({ chain, account: STEAK, transport: http(RPC) });
    for (const [to, amount] of [[deployer.address, 1_000_000n], [owner.address, 1_000_000_000n]] as const) {
      await publicClient.waitForTransactionReceipt({ hash: await steak.writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [to, amount] }) });
    }
    // Seed deposit, never withdrawn.
    await send(deployer, USDG, erc20, 'approve', [vault, 1_000_000n]);
    await send(deployer, vault, vaultAbi, 'deposit', [1_000_000n, '0x000000000000000000000000000000000000dEaD']);

    aspState = { chainId: 4663, entrypoint: entrypoint.toLowerCase(), lastScannedBlock: Number(deployBlock) - 1, deposits: [], published: [] };
    asp = startAsp(18432, () => aspState, join(aspDir, 'sets'));

    poolWallet = new PoolWallet({
      publicClient: publicClient as never,
      ownerWallet: wallet(owner),
      mnemonic: 'test test test test test test test test test test test junk',
      entrypoint,
      pool,
      asset: vault, // the pool's asset is the yield vault's share
      poolDeploymentBlock: deployBlock,
      relayer: { feeRecipient: relayer.address, relayFeeBPS: 0n, relay: () => Promise.reject(new Error('sessions go through the funder')) },
      prover: new WithdrawalProver(),
      associationSet: aspAssociationSet('http://127.0.0.1:18432'),
      store,
    });
  }, 300_000);

  afterAll(() => asp?.close());

  it('an owner wraps 1000 USDG and deposits the shares into the audited pool', async () => {
    await send(owner, USDG, erc20, 'approve', [vault, 1_000_000_000n]);
    await send(owner, vault, vaultAbi, 'deposit', [1_000_000_000n, owner.address]);
    ownerShares = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'balanceOf', args: [owner.address] });
    const note = await poolWallet.deposit(ownerShares);
    expect(BigInt(note.value)).toBe(ownerShares);
    expect(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'balanceOf', args: [pool] })).toBe(ownerShares);
    await approve();
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

    const received = await usdgOf(session);
    console.log(`   session ${session} received ${Number(received) / 1e6} USDG for ${Number(shares) / 1e6} shares`);
    expect(received).toBeGreaterThanOrEqual(10_000_000n);
    expect(received).toBeLessThan(10_010_000n);
    expect((await usdgOf(relayer.address)) - relayerBefore).toBeGreaterThan(0n);
    // Submitted by the relayer; the session never held gas.
    const t = await publicClient.getTransaction({ hash: tx });
    console.log(`   gas for the session funding transaction: ${(await publicClient.getTransactionReceipt({ hash: tx })).gasUsed}`);
    expect(t.from.toLowerCase()).toBe(relayer.address.toLowerCase());
    expect(await publicClient.getBalance({ address: session })).toBe(0n);
    // The change stays in the pool as a share commitment of the owner's.
    expect(BigInt(store.load().notes[0]!.value)).toBe(ownerShares - shares);
    expect(store.load().notes[0]!.spendCount).toBe(1);
    // The protocol fee went to everyone still holding shares.
    const priceAfter = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'convertToAssets', args: [1_000_000n] });
    expect(priceAfter).toBeGreaterThan(priceBefore);
  }, 600_000);

  it('funds a second session from the change commitment', async () => {
    await approve();
    const { session } = await openSession(5_000_000n);
    expect(await usdgOf(session)).toBeGreaterThanOrEqual(5_000_000n);
    expect(store.load().notes[0]!.spendCount).toBe(2);
  }, 600_000);
});
