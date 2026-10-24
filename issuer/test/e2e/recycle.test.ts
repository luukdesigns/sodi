/**
 * Recycling on a local fork of Robinhood Chain testnet: real USDG, the deployed pool, the HTTP relayer
 * submitting, and SodiRecycler deployed on the fork. Covers an agent holding the pool secret and one
 * using a session issuer.
 *
 * Flow per agent: pay a merchant -> rotate -> nothing is recycled while the old session's payment
 * authorizations could still be settled -> once idle, what's left goes back into the owner's pool as a
 * new deposit, submitted by the relayer, with the session never needing gas.
 */
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HttpRelayer,
  IssuerSessions,
  MemoryControls,
  MemoryStore,
  PoolWallet,
  type RecycleSubmitter,
  Rx402Client,
  WalletRelayer,
  WithdrawalProver,
  aspAssociationSet,
  depositedEvent,
  recyclerAbi,
} from '@sodi/rx402';
import { type Address, type Hex, createPublicClient, createTestClient, createWalletClient, defineChain, http, parseAbi, parseEventLogs } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer as startAsp } from '../../../asp/src/server.js';
import { runCycle } from '../../../asp/src/service.js';
import type { ServiceState } from '../../../asp/src/state.js';
import { startMerchant } from '../../../packages/rx402/test/e2e/merchant.js';
import { RelaySubmitter, loadPools } from '../../../relayer/src/relay.js';
import { startServer as startRelayer } from '../../../relayer/src/server.js';
import { SessionIssuer } from '../../src/issuer.js';
import { startServer as startIssuer } from '../../src/server.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const WHALE = (process.env.USDG_WHALE ?? '0xf0d65776d3ce5f4b6f5e6043326cee858df55506') as Address;
const deployment = JSON.parse(readFileSync(new URL('../../../contracts/deployments/46630.json', import.meta.url), 'utf8'));
const artifact = JSON.parse(readFileSync(new URL('../../../contracts/out/SodiRecycler.sol/SodiRecycler.json', import.meta.url), 'utf8'));
const ENTRYPOINT = deployment.contracts.Entrypoint as Address;
const POOL = deployment.pools.USDG.pool as Address;
const USDG = deployment.pools.USDG.asset as Address;

const ownerA = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const ownerB = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const relayerAcct = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
const facilitatorAcct = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a');
const POSTMAN_KEY = process.env.POSTMAN_PRIVATE_KEY as Hex;
const MERCHANT = '0x000000000000000000000000000000000000cafe' as Address;
const RECYCLE_FEE = 1_000n;

const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet (fork)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const testClient = createTestClient({ chain, mode: 'anvil', transport: http(RPC) });
const wallet = (account: ReturnType<typeof privateKeyToAccount>) => createWalletClient({ chain, account, transport: http(RPC) });
const erc20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const balance = (a: Address) => publicClient.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [a] });

describe('recycling sessions into the pool, on a testnet fork', () => {
  const aspState: ServiceState = { chainId: 46630, entrypoint: ENTRYPOINT.toLowerCase(), lastScannedBlock: deployment.deploymentBlock - 1, deposits: [], published: [] };
  const aspDir = join(tmpdir(), `sodi-recycle-asp-${Date.now()}`);
  const servers: { close(): unknown }[] = [];
  let recycler: Address;
  let submitter: RecycleSubmitter;
  let offset = 0;
  const now = () => Math.floor(Date.now() / 1000) + offset;
  const policy = { budget: 500_000n, maxPayments: 1, maxAgeSeconds: 3600, maxPaymentAmount: 100_000n };

  // Agent A holds the pool secret itself.
  const storeA = new MemoryStore();
  let clientA: Rx402Client;
  // Agent B holds only an agent key; the issuer holds pool B.
  const poolStoreB = new MemoryStore();
  const agentStoreB = new MemoryStore();
  let poolB: PoolWallet;
  let clientB: Rx402Client;

  const approve = () =>
    runCycle({
      publicClient,
      walletClient: wallet(privateKeyToAccount(POSTMAN_KEY)),
      entrypoint: ENTRYPOINT,
      pools: [POOL],
      policy: { blockedAddresses: new Set(), deniedLabels: new Set(), vettingDelaySeconds: 0 },
      state: aspState,
      stateFile: join(aspDir, 'state.json'),
      setsDir: join(aspDir, 'sets'),
      logChunkSize: 50_000,
      dryRun: false,
    });

  beforeAll(async () => {
    expect(POSTMAN_KEY, 'set POSTMAN_PRIVATE_KEY').toBeTruthy();
    await testClient.impersonateAccount({ address: WHALE });
    await testClient.setBalance({ address: WHALE, value: 10n ** 18n });
    const whale = createWalletClient({ chain, account: WHALE, transport: http(RPC) });
    for (const [o, amount] of [[ownerA, 1_500_000n], [ownerB, 1_000_000n]] as const) {
      await publicClient.waitForTransactionReceipt({ hash: await whale.writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [o.address, amount] }) });
    }

    const deployTx = await wallet(relayerAcct).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [ENTRYPOINT, USDG] });
    recycler = (await publicClient.waitForTransactionReceipt({ hash: deployTx })).contractAddress!;

    servers.push(startAsp(18422, () => aspState, join(aspDir, 'sets')));
    servers.push(startMerchant({ port: 18423, asset: USDG, payTo: MERCHANT, facilitator: wallet(facilitatorAcct), publicClient, prices: { '/v1/data': { amount: 10_000n, version: 1 } } }).server);
    const settings = {
      entrypoint: ENTRYPOINT,
      pools: await loadPools(publicClient as never, ENTRYPOINT, [POOL], 0n),
      feeRecipient: relayerAcct.address,
      relayFeeBPS: 0n,
      minWithdrawal: 0n,
      recycler,
      recycleFee: RECYCLE_FEE,
    };
    servers.push(startRelayer(18424, 46630, settings, new RelaySubmitter(publicClient as never, wallet(relayerAcct), settings), () => {}, { host: '127.0.0.1' }));
    const httpRelayer = await HttpRelayer.connect('http://127.0.0.1:18424', { chainId: 46630, entrypoint: ENTRYPOINT });
    submitter = httpRelayer.recycleSubmitter({ recycler, maxFee: 5_000n });

    const poolConfig = (mnemonic: string, owner: typeof ownerA, store: MemoryStore) => ({
      publicClient,
      ownerWallet: wallet(owner),
      mnemonic,
      entrypoint: ENTRYPOINT,
      pool: POOL,
      asset: USDG,
      poolDeploymentBlock: BigInt(deployment.deploymentBlock),
      relayer: new WalletRelayer(wallet(relayerAcct), publicClient, ENTRYPOINT),
      prover: new WithdrawalProver(),
      associationSet: aspAssociationSet('http://127.0.0.1:18422'),
      store,
      now,
    });
    clientA = new Rx402Client({ ...poolConfig('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', ownerA, storeA), policy });

    poolB = new PoolWallet(poolConfig('legal winner thank year wave sausage worth useful legal winner thank yellow', ownerB, poolStoreB));
    const agentKey = generatePrivateKey();
    const issuer = new SessionIssuer({ pool: poolB, store: poolStoreB, chainId: 46630, agents: [privateKeyToAccount(agentKey).address], controls: new MemoryControls(), maxSessionBudget: 500_000n, now });
    const issuerServer = startIssuer(issuer, 0);
    if (!issuerServer.listening) await new Promise((r) => issuerServer.once('listening', r));
    servers.push(issuerServer);
    const url = `http://127.0.0.1:${(issuerServer.address() as AddressInfo).port}`;
    clientB = new Rx402Client({ publicClient, asset: USDG, store: agentStoreB, policy, now, sessions: new IssuerSessions({ url, agentKey, publicClient, asset: USDG, store: agentStoreB, now }) });
  }, 180_000);

  afterAll(() => {
    for (const s of servers) s.close();
  });

  it('funds both pools and gets the deposits approved', async () => {
    await clientA.deposit(1_500_000n);
    await poolB.deposit(1_000_000n);
    await approve();
  }, 180_000);

  it('pays and rotates, leaving funds in the first session of each agent', async () => {
    for (const c of [clientA, clientB]) {
      expect((await c.fetch('http://127.0.0.1:18423/v1/data')).response.status).toBe(200);
      expect((await c.fetch('http://127.0.0.1:18423/v1/data')).response.status).toBe(200);
    }
    expect(storeA.load().sessions).toHaveLength(2);
    expect(agentStoreB.load().sessions).toHaveLength(2);
    expect(await balance(storeA.load().sessions[0]!.address)).toBe(490_000n);
  }, 600_000);

  it("doesn't recycle a session whose payments a merchant could still settle", async () => {
    expect(await clientA.recycleSessions({ submitter })).toEqual([]);
    expect(await clientB.recycleSessions({ submitter })).toEqual([]);
  }, 60_000);

  it('recycles an idle session into the owner pool, submitted by the relayer', async () => {
    offset = 700;
    const [first, current] = storeA.load().sessions;
    const relayerBefore = await balance(relayerAcct.address);
    const poolBefore = clientA.poolBalance()!;

    const outcomes = await clientA.recycleSessions({ submitter });
    expect(outcomes).toEqual([{ session: first!.address, amount: 490_000n, status: 'recycled', tx: expect.any(String) }]);
    expect(await balance(first!.address)).toBe(0n);
    expect(await balance(current!.address)).toBe(490_000n);
    expect((await balance(relayerAcct.address)) - relayerBefore).toBe(RECYCLE_FEE);
    expect(clientA.poolBalance()! - poolBefore).toBe(490_000n - RECYCLE_FEE);

    // A new deposit of the owner's, made by the recycler, refundable only to the session.
    const receipt = await publicClient.getTransactionReceipt({ hash: outcomes[0]!.tx! });
    expect(receipt.from.toLowerCase()).toBe(relayerAcct.address.toLowerCase());
    const [dep] = parseEventLogs({ abi: [depositedEvent], logs: receipt.logs }).filter((l) => l.address.toLowerCase() === POOL.toLowerCase());
    expect(dep!.args._depositor.toLowerCase()).toBe(recycler.toLowerCase());
    // Refunds are keyed by label, which survives partial withdrawals.
    expect(await publicClient.readContract({ address: recycler, abi: recyclerAbi, functionName: 'refundTo', args: [dep!.args._label] })).toBe(first!.address);
    // The session never held gas.
    expect(await publicClient.getBalance({ address: first!.address })).toBe(0n);
    expect(storeA.load().sessions[0]!.recycledTx).toBe(outcomes[0]!.tx);
    // Done once.
    expect(await clientA.recycleSessions({ submitter })).toEqual([]);
  }, 300_000);

  it('recycles into the issuer pool for an agent that holds no pool secret', async () => {
    const [first] = agentStoreB.load().sessions;
    const outcomes = await clientB.recycleSessions({ submitter });
    expect(outcomes).toMatchObject([{ session: first!.address, status: 'recycled' }]);
    expect(await balance(first!.address)).toBe(0n);
    // The issuer finds the new deposit on its next sync.
    const before = poolB.poolBalance();
    await poolB.sync();
    expect(poolB.poolBalance() - before).toBe(490_000n - RECYCLE_FEE);
    expect(agentStoreB.load().notes).toHaveLength(0);
  }, 300_000);

  it('reports sessions too small to recycle', async () => {
    // Spend the second session of agent A down below the pool minimum (0.01 USDG on testnet).
    const second = storeA.load().sessions[1]!;
    const sessionWallet = wallet(privateKeyToAccount(second.privateKey));
    await testClient.setBalance({ address: second.address, value: 10n ** 16n });
    await publicClient.waitForTransactionReceipt({ hash: await sessionWallet.writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [MERCHANT, 485_000n] }) });
    // Make it not current by opening a third session.
    expect((await clientA.fetch('http://127.0.0.1:18423/v1/data')).response.status).toBe(200);
    offset = 1_500;
    const outcomes = await clientA.recycleSessions({ submitter });
    expect(outcomes).toEqual([{ session: second.address, amount: 5_000n, status: 'too-small' }]);
  }, 600_000);
});
