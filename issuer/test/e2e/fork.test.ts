/**
 * The session issuer end to end on a local fork of Robinhood Chain testnet, against the deployed
 * Sodi pool, with real zero-knowledge withdrawals. The agent holds only an agent key.
 *
 * Flow: the owner deposits through the issuer's pool wallet -> the approval service approves it ->
 * the agent pays an x402 merchant; its session is funded by the issuer to an address derived from the
 * agent's key -> the issuer's 24-hour limit stops a second session, whatever the agent asks.
 */
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IssuerSessions,
  MemoryControls,
  MemoryStore,
  PaymentBlockedError,
  PoolWallet,
  Rx402Client,
  WalletRelayer,
  WithdrawalProver,
  agentSessionPrivateKey,
  aspAssociationSet,
} from '@sodi/rx402';
import { type Address, createPublicClient, createTestClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer as startAsp } from '../../../asp/src/server.js';
import { runCycle } from '../../../asp/src/service.js';
import type { ServiceState } from '../../../asp/src/state.js';
import { startMerchant } from '../../../packages/rx402/test/e2e/merchant.js';
import { SessionIssuer } from '../../src/issuer.js';
import { startServer } from '../../src/server.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const WHALE = (process.env.USDG_WHALE ?? '0xf0d65776d3ce5f4b6f5e6043326cee858df55506') as Address;
const deployment = JSON.parse(readFileSync(new URL('../../../contracts/deployments/46630.json', import.meta.url), 'utf8'));
const ENTRYPOINT = deployment.contracts.Entrypoint as Address;
const POOL = deployment.pools.USDG.pool as Address;
const USDG = deployment.pools.USDG.asset as Address;

const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const relayerAcct = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
const facilitatorAcct = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a');
const POSTMAN_KEY = process.env.POSTMAN_PRIVATE_KEY as `0x${string}`;
const MERCHANT = '0x000000000000000000000000000000000000bEEF' as Address;

const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet (fork)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const testClient = createTestClient({ chain, mode: 'anvil', transport: http(RPC) });
const wallet = (account: ReturnType<typeof privateKeyToAccount>) => createWalletClient({ chain, account, transport: http(RPC) });
const erc20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const balance = (a: Address) => publicClient.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [a] });

describe('session issuer end to end on a testnet fork', () => {
  const poolStore = new MemoryStore();
  const agentStore = new MemoryStore();
  const agentKey = generatePrivateKey();
  const agent = privateKeyToAccount(agentKey);
  const aspState: ServiceState = { chainId: 46630, entrypoint: ENTRYPOINT.toLowerCase(), lastScannedBlock: deployment.deploymentBlock - 1, deposits: [], published: [] };
  const aspDir = join(tmpdir(), `sodi-issuer-asp-${Date.now()}`);
  let aspServer: ReturnType<typeof startAsp>;
  let merchant: ReturnType<typeof startMerchant>;
  let issuerServer: ReturnType<typeof startServer>;
  let poolWallet: PoolWallet;
  let client: Rx402Client;

  beforeAll(async () => {
    expect(POSTMAN_KEY, 'set POSTMAN_PRIVATE_KEY').toBeTruthy();
    await testClient.impersonateAccount({ address: WHALE });
    await testClient.setBalance({ address: WHALE, value: 10n ** 18n });
    const whale = createWalletClient({ chain, account: WHALE, transport: http(RPC) });
    await publicClient.waitForTransactionReceipt({ hash: await whale.writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [owner.address, 2_000_000n] }) });

    aspServer = startAsp(18412, () => aspState, join(aspDir, 'sets'));
    merchant = startMerchant({ port: 18413, asset: USDG, payTo: MERCHANT, facilitator: wallet(facilitatorAcct), publicClient, prices: { '/v1/data': { amount: 10_000n, version: 1 } } });

    // The owner's side: the pool wallet, behind the issuer.
    poolWallet = new PoolWallet({
      publicClient,
      ownerWallet: wallet(owner),
      mnemonic: 'test test test test test test test test test test test junk',
      entrypoint: ENTRYPOINT,
      pool: POOL,
      asset: USDG,
      poolDeploymentBlock: BigInt(deployment.deploymentBlock),
      relayer: new WalletRelayer(wallet(relayerAcct), publicClient, ENTRYPOINT),
      prover: new WithdrawalProver(),
      associationSet: aspAssociationSet('http://127.0.0.1:18412'),
      store: poolStore,
    });
    const issuer = new SessionIssuer({
      pool: poolWallet,
      store: poolStore,
      chainId: 46630,
      agents: [agent.address],
      controls: new MemoryControls(),
      maxSessionBudget: 500_000n,
      dailyLimit: 800_000n,
    });
    issuerServer = startServer(issuer, 0);
    if (!issuerServer.listening) await new Promise((r) => issuerServer.once('listening', r));

    // The agent's side: an agent key and nothing else.
    client = new Rx402Client({
      publicClient,
      asset: USDG,
      store: agentStore,
      sessions: new IssuerSessions({ url: `http://127.0.0.1:${(issuerServer.address() as AddressInfo).port}`, agentKey, publicClient, asset: USDG, store: agentStore }),
      policy: { budget: 500_000n, maxPayments: 1, maxAgeSeconds: 3600, maxPaymentAmount: 100_000n },
    });
  }, 120_000);

  afterAll(() => {
    aspServer?.close();
    merchant?.server.close();
    issuerServer?.close();
  });

  it('deposits through the pool wallet and gets approved', async () => {
    const note = await poolWallet.deposit(2_000_000n);
    expect(BigInt(note.value)).toBe(2_000_000n);
    await runCycle({
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
  }, 180_000);

  it('pays a merchant from a session the issuer funded to an address only the agent controls', async () => {
    const { response, payment } = await client.fetch('http://127.0.0.1:18413/v1/data');
    expect(response.status).toBe(200);
    const expected = privateKeyToAccount(agentSessionPrivateKey(agentKey, 0n)).address;
    expect(payment?.from).toBe(expected);
    expect(merchant.settlements[0]!.from.toLowerCase()).toBe(expected.toLowerCase());
    expect(await balance(MERCHANT)).toBe(10_000n);
    expect(await balance(expected)).toBe(490_000n);
    // Funded by the relayer's ZK withdrawal, not by the owner or the issuer.
    const session = agentStore.load().sessions[0]!;
    const tx = await publicClient.getTransaction({ hash: session.fundingTx });
    expect(tx.from.toLowerCase()).toBe(relayerAcct.address.toLowerCase());
    // The agent's store has no pool notes: it never saw the pool secret.
    expect(agentStore.load().notes).toHaveLength(0);
    expect(poolStore.load().grants).toMatchObject([{ agent: agent.address, address: expected, budget: '500000', status: 'funded' }]);
  }, 600_000);

  it("stops at the issuer's 24-hour limit, whatever the agent asks for", async () => {
    // maxPayments is 1, so this payment needs a second 0.5 session: 1.0 > the 0.8 limit.
    const before = await balance(POOL);
    const err = await client.fetch('http://127.0.0.1:18413/v1/data').catch((e) => e);
    expect(err).toBeInstanceOf(PaymentBlockedError);
    expect(err.reason).toBe('over-daily-limit');
    expect(await balance(POOL)).toBe(before);
    expect(poolStore.load().grants).toHaveLength(1);
  }, 600_000);
});
