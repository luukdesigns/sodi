/**
 * Agents on the yield pool, end to end with real proofs, on a fork of Robinhood Chain mainnet (real
 * USDG, real Steakhouse USDG Morpho vault):
 *
 *   - an rx402 agent holding the pool secret pays an x402 merchant; its sessions are sized in shares
 *     and funded through the HTTP relayer's /fund and the session funder, with exactly the USDG budget;
 *   - an agent with only an agent key does the same through a session issuer;
 *   - a session funded while the agent was down is recovered from the chain alone.
 */
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer as startAsp } from '../../../../asp/src/server.js';
import { runCycle } from '../../../../asp/src/service.js';
import type { ServiceState } from '../../../../asp/src/state.js';
import { SessionIssuer } from '../../../../issuer/src/issuer.js';
import { startServer as startIssuer } from '../../../../issuer/src/server.js';
import { RelaySubmitter, loadPools } from '../../../../relayer/src/relay.js';
import { startServer as startRelayer } from '../../../../relayer/src/server.js';
import { HttpRelayer, IssuerSessions, MemoryControls, MemoryStore, PoolWallet, Rx402Client, WithdrawalProver, aspAssociationSet } from '../../src/index.js';
import { startMerchant } from '../e2e/merchant.js';
import { USDG, type YieldStack, deployYieldStack, fundUsdg, publicClient, usdgOf, wallet } from './stack.js';

const deployer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const ownerA = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const postman = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const relayerAcct = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
const facilitator = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a');
const ownerB = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
const MERCHANT = '0x000000000000000000000000000000000000bEEF' as Address;
const MNEMONIC_A = 'test test test test test test test test test test test junk';
const MNEMONIC_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const RELAY_FEE_BPS = 20n;

describe('agents on the yield pool, on a mainnet fork', () => {
  let s: YieldStack;
  let aspState: ServiceState;
  const aspDir = join(tmpdir(), `sodi-yield-agents-${Date.now()}`);
  const servers: { close(): unknown }[] = [];
  let relayer: HttpRelayer;
  let merchant: ReturnType<typeof startMerchant>;
  const storeA = new MemoryStore();
  let agentA: Rx402Client;
  const poolStoreB = new MemoryStore();
  let poolB: PoolWallet;
  let agentB: Rx402Client;
  const policy = { budget: 2_000_000n, maxPayments: 1, maxAgeSeconds: 3600, maxPaymentAmount: 500_000n };

  // The fork's clock may run ahead of real time (another test file moves it), so the approval service
  // goes by chain time for its vetting window.
  const approve = async () => {
    const chainNow = Number((await publicClient.getBlock()).timestamp);
    return runCycle({
      now: () => chainNow,
      publicClient: publicClient as never,
      walletClient: wallet(postman) as never,
      entrypoint: s.entrypoint,
      pools: [s.pool],
      forwarders: [s.router],
      policy: { blockedAddresses: new Set(), deniedLabels: new Set(), vettingDelaySeconds: 0 },
      state: aspState,
      stateFile: join(aspDir, 'state.json'),
      setsDir: join(aspDir, 'sets'),
      logChunkSize: 5_000,
      dryRun: false,
    });
  };

  const poolSettings = () => ({
    entrypoint: s.entrypoint,
    pool: s.pool,
    asset: USDG,
    yieldPool: { vault: s.vault, router: s.router, funder: s.funder },
    poolDeploymentBlock: s.deployBlock,
  });

  beforeAll(async () => {
    await fundUsdg([[deployer.address, 1_000_000n], [ownerA.address, 100_000_000n], [ownerB.address, 100_000_000n]]);
    s = await deployYieldStack(deployer, postman.address);
    aspState = { chainId: 4663, entrypoint: s.entrypoint.toLowerCase(), lastScannedBlock: Number(s.deployBlock) - 1, deposits: [], published: [] };
    servers.push(startAsp(18442, () => aspState, join(aspDir, 'sets')));

    const settings = {
      entrypoint: s.entrypoint,
      pools: await loadPools(publicClient as never, s.entrypoint, [s.pool], RELAY_FEE_BPS),
      feeRecipient: relayerAcct.address,
      relayFeeBPS: RELAY_FEE_BPS,
      minWithdrawal: 0n,
      funder: s.funder,
    };
    servers.push(startRelayer(18443, 4663, settings, new RelaySubmitter(publicClient as never, wallet(relayerAcct), settings), () => {}, { host: '127.0.0.1' }));
    relayer = await HttpRelayer.connect('http://127.0.0.1:18443', { chainId: 4663, entrypoint: s.entrypoint, feeRecipient: relayerAcct.address, maxFeeBPS: RELAY_FEE_BPS });
    merchant = startMerchant({ port: 18444, chainId: 4663, asset: USDG, payTo: MERCHANT, facilitator: wallet(facilitator), publicClient: publicClient as never, prices: { '/data': { amount: 250_000n, version: 2 } } });
    servers.push(merchant.server);

    const common = { publicClient: publicClient as never, relayer, prover: new WithdrawalProver(), associationSet: aspAssociationSet('http://127.0.0.1:18442') };
    agentA = new Rx402Client({ ...common, ...poolSettings(), ownerWallet: wallet(ownerA), mnemonic: MNEMONIC_A, store: storeA, policy });

    poolB = new PoolWallet({ ...common, ...poolSettings(), ownerWallet: wallet(ownerB), mnemonic: MNEMONIC_B, store: poolStoreB });
    const agentKey = generatePrivateKey();
    const issuer = new SessionIssuer({ pool: poolB, store: poolStoreB, chainId: 4663, agents: [privateKeyToAccount(agentKey).address], controls: new MemoryControls(), maxSessionBudget: 5_000_000n, dailyLimit: 20_000_000n });
    const issuerServer = startIssuer(issuer, 0);
    if (!issuerServer.listening) await new Promise((r) => issuerServer.once('listening', r));
    servers.push(issuerServer);
    const agentStoreB = new MemoryStore();
    agentB = new Rx402Client({
      publicClient: publicClient as never,
      asset: USDG,
      store: agentStoreB,
      policy,
      sessions: new IssuerSessions({ url: `http://127.0.0.1:${(issuerServer.address() as AddressInfo).port}`, agentKey, publicClient: publicClient as never, asset: USDG, store: agentStoreB }),
    });
  }, 300_000);

  afterAll(() => {
    for (const x of servers) x.close();
  });

  it('both owners deposit USDG through the router and get approved', async () => {
    const a = await agentA.deposit(50_000_000n);
    const b = await poolB.deposit(50_000_000n);
    expect(BigInt(a.value)).toBeGreaterThan(49_000_000n); // shares, a little under 1:1 after Morpho interest
    expect(BigInt(b.value)).toBeGreaterThan(49_000_000n);
    await approve();
    expect(aspState.deposits.filter((d) => d.status === 'approved' && d.kind === 'forwarded')).toHaveLength(2);
  }, 300_000);

  it('an agent holding the pool secret pays a merchant from a yield-pool session funded through /fund', async () => {
    const { response, payment } = await agentA.fetch('http://127.0.0.1:18444/data');
    expect(response.status).toBe(200);
    const session = storeA.load().sessions[0]!;
    expect(session.budget).toBe('2000000'); // exactly the USDG budget
    expect(payment?.from).toBe(session.address);
    expect(await usdgOf(session.address)).toBe(2_000_000n - 250_000n);
    expect(await usdgOf(MERCHANT)).toBe(250_000n);
    const tx = await publicClient.getTransaction({ hash: session.fundingTx });
    expect(tx.from.toLowerCase()).toBe(relayerAcct.address.toLowerCase());
    expect(tx.to?.toLowerCase()).toBe(s.funder.toLowerCase());
  }, 600_000);

  it('rotates: the next session comes from the share change commitment', async () => {
    const { response } = await agentA.fetch('http://127.0.0.1:18444/data');
    expect(response.status).toBe(200);
    expect(storeA.load().sessions).toHaveLength(2);
    expect(storeA.load().notes[0]!.spendCount).toBe(2);
    expect(await usdgOf(storeA.load().sessions[1]!.address)).toBe(1_750_000n);
  }, 600_000);

  it('an agent with only an agent key pays through a session issuer on the yield pool', async () => {
    const { response, payment } = await agentB.fetch('http://127.0.0.1:18444/data');
    expect(response.status).toBe(200);
    expect(await usdgOf(payment!.from)).toBe(2_000_000n - 250_000n);
    expect(poolStoreB.load().grants).toMatchObject([{ status: 'funded', budget: '2000000', received: '2000000' }]);
  }, 600_000);

  it('recovers yield-pool sessions from the chain alone', async () => {
    // Same mnemonic, empty store: the deposit and both sessions come back from the chain.
    const store = new MemoryStore();
    store.save({ version: 1, notes: [], depositCounts: { [(storeA.load().notes[0]!.scope)]: 1 }, sessions: [] });
    const recovered = new PoolWallet({ publicClient: publicClient as never, ...poolSettings(), mnemonic: MNEMONIC_A, relayer, prover: new WithdrawalProver(), associationSet: aspAssociationSet('http://127.0.0.1:18442'), store });
    await recovered.sync();
    const st = store.load();
    expect(st.notes[0]!.spendCount).toBe(2);
    expect(st.sessions.map((x) => x.address).sort()).toEqual(storeA.load().sessions.map((x) => x.address).sort());
    expect(st.sessions.every((x) => x.budget === '2000000')).toBe(true);
  }, 300_000);
});
