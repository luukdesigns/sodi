/**
 * Stealth x402 payments end to end on a fork of Robinhood Chain testnet, with the real Sodi pool,
 * USDG, and the canonical ERC-5564 announcer and ERC-6538 registry. Run with test/e2e/run-fork.sh.
 *
 * An rx402 agent pays a merchant that offers stealth three times: each payment lands at a different
 * one-time address and none at the merchant's public address. The merchant finds all three from the
 * chain alone and sweeps them. A merchant without the offer, and an agent with stealth turned off,
 * pay `payTo` as before.
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Address,
  type Hex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../../../../asp/src/server.js';
import { runCycle } from '../../../../asp/src/service.js';
import type { ServiceState } from '../../../../asp/src/state.js';
import { MemoryStore, Rx402Client, WalletRelayer, WithdrawalProver, aspAssociationSet } from '../../../../packages/rx402/src/index.js';
import {
  ERC5564_ANNOUNCER,
  type FoundPayment,
  StealthMerchant,
  StealthReceiver,
  deriveStealthKeys,
  lookupMetaAddress,
  registerMetaAddress,
  viewingOnly,
} from '../../src/index.js';
import { startStealthMerchant } from '../../demo/shop.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const WHALE = (process.env.USDG_WHALE ?? '0xf0d65776d3ce5f4b6f5e6043326cee858df55506') as Address;
const deployment = JSON.parse(readFileSync(new URL('../../../../contracts/deployments/46630.json', import.meta.url), 'utf8'));
const ENTRYPOINT = deployment.contracts.Entrypoint as Address;
const POOL = deployment.pools.USDG.pool as Address;
const USDG = deployment.pools.USDG.asset as Address;
const POSTMAN_KEY = process.env.POSTMAN_PRIVATE_KEY as Hex;
const settlerArtifact = JSON.parse(
  readFileSync(new URL('../../../contracts/out/SodiStealthSettler.sol/SodiStealthSettler.json', import.meta.url), 'utf8'),
);

const chain = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet (fork)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const testClient = createTestClient({ chain, mode: 'anvil', transport: http(RPC) });
const fresh = () => privateKeyToAccount(generatePrivateKey());
const wallet = (account: ReturnType<typeof fresh>) => createWalletClient({ chain, account, transport: http(RPC) });
const erc20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const balance = (a: Address) => publicClient.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [a] });

const owner = fresh();
const relayerAcct = fresh();
const facilitatorAcct = fresh();
const merchantAcct = fresh();
const PRICE = 20_000n;

describe('stealth x402 payments on a testnet fork', () => {
  const store = new MemoryStore();
  const aspState: ServiceState = {
    chainId: 46630,
    entrypoint: ENTRYPOINT.toLowerCase(),
    lastScannedBlock: deployment.deploymentBlock - 1,
    deposits: [],
    published: [],
  };
  const aspDir = join(tmpdir(), `sodi-stealth-asp-${Date.now()}`);
  let aspServer: ReturnType<typeof startServer>;
  let shop: ReturnType<typeof startStealthMerchant>;
  let merchant: StealthMerchant;
  let settler: Address;
  let startBlock: bigint;
  const clientConfig = () => ({
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
    store,
    policy: { budget: 1_000_000n, maxPayments: 10, maxAgeSeconds: 3600, maxPaymentAmount: 100_000n },
  });
  let client: Rx402Client;
  const found: FoundPayment[] = [];

  beforeAll(async () => {
    expect(POSTMAN_KEY, 'set POSTMAN_PRIVATE_KEY').toBeTruthy();
    for (const a of [owner, relayerAcct, facilitatorAcct, merchantAcct]) await testClient.setBalance({ address: a.address, value: 10n ** 18n });
    await testClient.impersonateAccount({ address: WHALE });
    await testClient.setBalance({ address: WHALE, value: 10n ** 18n });
    const whale = createWalletClient({ chain, account: WHALE, transport: http(RPC) });
    await publicClient.waitForTransactionReceipt({
      hash: await whale.writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [owner.address, 2_000_000n] }),
    });

    const deployTx = await wallet(facilitatorAcct).deployContract({
      abi: settlerArtifact.abi,
      bytecode: settlerArtifact.bytecode.object,
      args: [ERC5564_ANNOUNCER],
    });
    settler = (await publicClient.waitForTransactionReceipt({ hash: deployTx })).contractAddress!;
    startBlock = await publicClient.getBlockNumber();

    // The merchant derives its keys from its wallet; its server only ever gets the viewing half.
    const keys = await deriveStealthKeys(wallet(merchantAcct));
    merchant = new StealthMerchant(keys);
    aspServer = startServer(18412, () => aspState, join(aspDir, 'sets'));
    shop = startStealthMerchant({
      port: 18413,
      asset: USDG,
      payTo: merchantAcct.address,
      receiver: new StealthReceiver(viewingOnly(keys)),
      settler,
      facilitator: wallet(facilitatorAcct),
      publicClient,
      price: PRICE,
      chainId: 46630,
    });
    client = new Rx402Client(clientConfig());

    await client.deposit(2_000_000n);
    await runCycle({
      publicClient,
      walletClient: createWalletClient({ chain, account: privateKeyToAccount(POSTMAN_KEY), transport: http(RPC) }),
      entrypoint: ENTRYPOINT,
      pools: [POOL],
      policy: { blockedAddresses: new Set(), deniedLabels: new Set(), vettingDelaySeconds: 0 },
      state: aspState,
      stateFile: join(aspDir, 'state.json'),
      setsDir: join(aspDir, 'sets'),
      logChunkSize: 50_000,
      dryRun: false,
    });
  }, 600_000);

  afterAll(() => {
    aspServer?.close();
    shop?.server.close();
  });

  it('publishes the merchant meta-address in the ERC-6538 registry', async () => {
    await registerMetaAddress(wallet(merchantAcct), publicClient, merchant.metaAddress);
    expect(await lookupMetaAddress(publicClient, merchantAcct.address)).toBe(merchant.metaAddress);
  });

  it('pays three times, to three different one-time addresses, never to payTo', async () => {
    const payments = [];
    for (let i = 0; i < 3; i++) {
      const { response, payment } = await client.fetch('http://127.0.0.1:18413/stealth');
      expect(response.status, await response.clone().text()).toBe(200);
      expect(payment?.stealth).toBe(true);
      payments.push(payment!);
    }
    const recipients = new Set(payments.map((p) => p.payTo.toLowerCase()));
    expect(recipients.size).toBe(3);
    expect(recipients.has(merchantAcct.address.toLowerCase())).toBe(false);
    for (const p of payments) expect(await balance(p.payTo)).toBe(PRICE);
    expect(await balance(merchantAcct.address)).toBe(0n);
  }, 900_000);

  it('still pays merchants without the offer at their public address', async () => {
    const { response, payment } = await client.fetch('http://127.0.0.1:18413/plain');
    expect(response.status).toBe(200);
    expect(payment?.stealth).toBe(false);
    expect(payment?.payTo).toBe(merchantAcct.address);
    expect(await balance(merchantAcct.address)).toBe(PRICE);
  }, 600_000);

  it('pays payTo when the agent turns stealth off', async () => {
    const plainClient = new Rx402Client({ ...clientConfig(), stealth: false });
    const { response, payment } = await plainClient.fetch('http://127.0.0.1:18413/stealth');
    expect(response.status).toBe(200);
    expect(payment?.stealth).toBe(false);
    expect(await balance(merchantAcct.address)).toBe(2n * PRICE);
  }, 600_000);

  it('finds exactly its stealth payments from on-chain announcements', async () => {
    found.push(...(await merchant.scan(publicClient, { fromBlock: startBlock, caller: settler })));
    expect(found).toHaveLength(3);
    for (const f of found) {
      expect(f.token?.toLowerCase()).toBe(USDG.toLowerCase());
      expect(f.amount).toBe(PRICE);
    }
    const stranger = new StealthReceiver(viewingOnly(await deriveStealthKeys(wallet(fresh()))));
    expect(await stranger.scan(publicClient, { fromBlock: startBlock, caller: settler })).toHaveLength(0);
  }, 120_000);

  it('sweeps the stealth addresses without them ever holding gas', async () => {
    const vault = fresh().address;
    const swept = await merchant.sweep({
      publicClient,
      gasPayer: wallet(facilitatorAcct),
      payments: found,
      token: USDG,
      domain: { name: 'Global Dollar', version: '1' },
      to: vault,
    });
    expect(swept).toHaveLength(3);
    expect(await balance(vault)).toBe(3n * PRICE);
    for (const f of found) {
      expect(await balance(f.stealthAddress)).toBe(0n);
      expect(await publicClient.getBalance({ address: f.stealthAddress })).toBe(0n);
    }
  }, 120_000);
});
