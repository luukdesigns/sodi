/**
 * End-to-end on a local fork of Robinhood Chain testnet, against the deployed Sodi pool.
 * Requires anvil forking testnet (see test/e2e/run-fork.sh) and a USDG holder to impersonate.
 *
 * Flow: owner deposits USDG -> approval service publishes the association set -> agent pays two
 * x402 merchants (v1 and v2) from a private session funded by a real ZK withdrawal -> policy
 * forces a rotation, so a second session is funded from the change commitment of the first.
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { approvedLabels } from '../../../../asp/src/screening.js';
import { startServer } from '../../../../asp/src/server.js';
import { runCycle } from '../../../../asp/src/service.js';
import type { ServiceState } from '../../../../asp/src/state.js';
import { MemoryStore, Rx402Client, WalletRelayer, WithdrawalProver, aspAssociationSet } from '../../src/index.js';
import { startMerchant } from './merchant.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const WHALE = (process.env.USDG_WHALE ?? '0xf0d65776d3ce5f4b6f5e6043326cee858df55506') as Address;
const deployment = JSON.parse(
  readFileSync(new URL('../../../../contracts/deployments/46630.json', import.meta.url), 'utf8'),
);
const ENTRYPOINT = deployment.contracts.Entrypoint as Address;
const POOL = deployment.pools.USDG.pool as Address;
const USDG = deployment.pools.USDG.asset as Address;

// anvil default accounts; postman is the testnet deployer, which holds ASP_POSTMAN.
const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const relayerAcct = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
const facilitatorAcct = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a');
const POSTMAN_KEY = process.env.POSTMAN_PRIVATE_KEY as `0x${string}`;
const MERCHANT = '0x000000000000000000000000000000000000bEEF' as Address;

const chain = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet (fork)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const testClient = createTestClient({ chain, mode: 'anvil', transport: http(RPC) });
const wallet = (account: ReturnType<typeof privateKeyToAccount>) =>
  createWalletClient({ chain, account, transport: http(RPC) });
const erc20 = parseAbi([
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const balance = (a: Address) =>
  publicClient.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [a] });

describe('rx402 end to end on a testnet fork', () => {
  const store = new MemoryStore();
  const aspState: ServiceState = {
    chainId: 46630,
    entrypoint: ENTRYPOINT.toLowerCase(),
    lastScannedBlock: deployment.deploymentBlock - 1,
    deposits: [],
    published: [],
  };
  const aspDir = join(tmpdir(), `sodi-asp-${Date.now()}`);
  let aspServer: ReturnType<typeof startServer>;
  let merchant: ReturnType<typeof startMerchant>;
  let client: Rx402Client;

  const publishAssociationSet = () =>
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
    // Fund the owner with USDG from an existing testnet holder (fork only).
    await testClient.impersonateAccount({ address: WHALE });
    await testClient.setBalance({ address: WHALE, value: 10n ** 18n });
    const whale = createWalletClient({ chain, account: WHALE, transport: http(RPC) });
    await publicClient.waitForTransactionReceipt({
      hash: await whale.writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [owner.address, 3_000_000n] }),
    });

    aspServer = startServer(18402, () => aspState, join(aspDir, 'sets'));
    merchant = startMerchant({
      port: 18403,
      asset: USDG,
      payTo: MERCHANT,
      facilitator: wallet(facilitatorAcct),
      publicClient,
      prices: { '/v1/data': { amount: 10_000n, version: 1 }, '/v2/data': { amount: 25_000n, version: 2 } },
    });

    client = new Rx402Client({
      publicClient,
      ownerWallet: wallet(owner),
      mnemonic: 'test test test test test test test test test test test junk',
      entrypoint: ENTRYPOINT,
      pool: POOL,
      asset: USDG,
      poolDeploymentBlock: BigInt(deployment.deploymentBlock),
      relayer: new WalletRelayer(wallet(relayerAcct), publicClient, ENTRYPOINT),
      prover: new WithdrawalProver(),
      associationSet: aspAssociationSet('http://127.0.0.1:18402'),
      store,
      policy: { budget: 1_000_000n, maxPayments: 2, maxAgeSeconds: 3600, maxPaymentAmount: 100_000n },
    });
  }, 120_000);

  afterAll(() => {
    aspServer?.close();
    merchant?.server.close();
  });

  it('deposits into the pool (public step)', async () => {
    const before = await balance(POOL);
    const note = await client.deposit(3_000_000n);
    expect(BigInt(note.value)).toBe(3_000_000n);
    expect((await balance(POOL)) - before).toBe(3_000_000n);
    expect(client.poolBalance()).toBe(3_000_000n);
  }, 120_000);

  it('gets the deposit approved by the approval service', async () => {
    const r = await publishAssociationSet();
    const label = store.load().notes[0]!.label;
    expect(approvedLabels(aspState.deposits).map(String)).toContain(label);
    expect(r.root).toBe(r.published?.root ?? r.onChainRoot);
  }, 120_000);

  it('pays an x402 v1 merchant from a fresh private session', async () => {
    const { response, payment } = await client.fetch('http://127.0.0.1:18403/v1/data');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: 'paid content for /v1/data' });

    const session = store.load().sessions[0]!;
    expect(payment?.from).toBe(session.address);
    expect(session.address).not.toBe(owner.address);
    expect(await balance(MERCHANT)).toBe(10_000n);
    expect(await balance(session.address)).toBe(1_000_000n - 10_000n);
    // The merchant was paid by the session address, never the owner.
    expect(merchant.settlements[0]!.from.toLowerCase()).toBe(session.address.toLowerCase());
    // The session was funded by the relayer's transaction, not by the owner.
    const tx = await publicClient.getTransaction({ hash: session.fundingTx });
    expect(tx.from.toLowerCase()).toBe(relayerAcct.address.toLowerCase());
  }, 600_000);

  it('pays an x402 v2 merchant from the same session', async () => {
    const { response } = await client.fetch('http://127.0.0.1:18403/v2/data');
    expect(response.status).toBe(200);
    const s = store.load().sessions;
    expect(s).toHaveLength(1);
    expect(s[0]!.payments).toBe(2);
    expect(await balance(MERCHANT)).toBe(35_000n);
  }, 600_000);

  it('rotates to a new address, funded from the change of the first withdrawal', async () => {
    const { response, payment } = await client.fetch('http://127.0.0.1:18403/v1/data');
    expect(response.status).toBe(200);
    const sessions = store.load().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.address).not.toBe(sessions[0]!.address);
    expect(payment?.from).toBe(sessions[1]!.address);

    const note = store.load().notes[0]!;
    expect(note.spendCount).toBe(2);
    expect(BigInt(note.value)).toBe(1_000_000n);
    expect(await balance(MERCHANT)).toBe(45_000n);
  }, 600_000);
});
