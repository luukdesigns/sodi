/**
 * Full stack on a local fork of Robinhood Chain testnet:
 *   MCP client -> Sodi MCP tools -> rx402 -> Sodi relayer (HTTP) -> deployed pool,
 * with the approval service publishing the association set and an x402 merchant to pay.
 * Run with test/e2e/run-fork.sh (needs POSTMAN_PRIVATE_KEY).
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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

import { startServer as startAsp } from '../../../../asp/src/server.js';
import { runCycle } from '../../../../asp/src/service.js';
import type { ServiceState } from '../../../../asp/src/state.js';
import { RelaySubmitter, loadPools } from '../../../../relayer/src/relay.js';
import { startServer as startRelayer } from '../../../../relayer/src/server.js';
import { HttpRelayer, MemoryStore, Rx402Client, WithdrawalProver, aspAssociationSet } from '../../../rx402/src/index.js';
import { startMerchant } from '../../../rx402/test/e2e/merchant.js';
import { createSodiMcpServer } from '../../src/tools.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const WHALE = (process.env.USDG_WHALE ?? '0xf0d65776d3ce5f4b6f5e6043326cee858df55506') as Address;
const deployment = JSON.parse(
  readFileSync(new URL('../../../../contracts/deployments/46630.json', import.meta.url), 'utf8'),
);
const ENTRYPOINT = deployment.contracts.Entrypoint as Address;
const POOL = deployment.pools.USDG.pool as Address;
const USDG = deployment.pools.USDG.asset as Address;
const POSTMAN_KEY = process.env.POSTMAN_PRIVATE_KEY as `0x${string}`;

// Different anvil accounts from the rx402 test, so both suites can share one fork.
const owner = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
const relayerAcct = privateKeyToAccount('0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e');
const facilitatorAcct = privateKeyToAccount('0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356');
const MERCHANT = '0x000000000000000000000000000000000000cafe' as Address;
const RELAY_FEE_BPS = 50n; // 0.5%
const RECYCLE_FEE = 1_000n;
const artifact = JSON.parse(readFileSync(new URL('../../../../contracts/out/SodiRecycler.sol/SodiRecycler.json', import.meta.url), 'utf8'));

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
const erc20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const balance = (a: Address) => publicClient.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [a] });

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
const parse = (r: ToolResult) => JSON.parse(r.content[0]!.text);

describe('Sodi stack end to end: MCP -> rx402 -> relayer -> pool', () => {
  const dir = join(tmpdir(), `sodi-stack-${Date.now()}`);
  const aspState: ServiceState = {
    chainId: 46630,
    entrypoint: ENTRYPOINT.toLowerCase(),
    lastScannedBlock: deployment.deploymentBlock - 1,
    deposits: [],
    published: [],
  };
  const servers: { close(): void }[] = [];
  let mcp: Client;
  let call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  let offset = 0;

  beforeAll(async () => {
    expect(POSTMAN_KEY, 'set POSTMAN_PRIVATE_KEY').toBeTruthy();
    await testClient.impersonateAccount({ address: WHALE });
    await testClient.setBalance({ address: WHALE, value: 10n ** 18n });
    const whale = createWalletClient({ chain, account: WHALE, transport: http(RPC) });
    await publicClient.waitForTransactionReceipt({
      hash: await whale.writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [owner.address, 3_000_000n] }),
    });

    // Approval service API
    servers.push(startAsp(28402, () => aspState, join(dir, 'sets')));

    const deployTx = await wallet(relayerAcct).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [ENTRYPOINT, USDG] });
    const recycler = (await publicClient.waitForTransactionReceipt({ hash: deployTx })).contractAddress!;

    // Relayer service
    const settings = {
      entrypoint: ENTRYPOINT,
      pools: await loadPools(publicClient, ENTRYPOINT, [POOL], RELAY_FEE_BPS),
      feeRecipient: relayerAcct.address,
      relayFeeBPS: RELAY_FEE_BPS,
      minWithdrawal: 100_000n,
      recycler,
      recycleFee: RECYCLE_FEE,
    };
    servers.push(startRelayer(28403, 46630, settings, new RelaySubmitter(publicClient, wallet(relayerAcct), settings)));

    // x402 merchant
    const merchant = startMerchant({
      port: 28404,
      asset: USDG,
      payTo: MERCHANT,
      facilitator: wallet(facilitatorAcct),
      publicClient,
      prices: { '/weather': { amount: 10_000n, version: 1 }, '/news': { amount: 25_000n, version: 2 } },
    });
    servers.push(merchant.server);

    const relayer = await HttpRelayer.connect('http://127.0.0.1:28403');
    const client = new Rx402Client({
      publicClient,
      ownerWallet: wallet(owner),
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      entrypoint: ENTRYPOINT,
      pool: POOL,
      asset: USDG,
      poolDeploymentBlock: BigInt(deployment.deploymentBlock),
      relayer,
      prover: new WithdrawalProver(),
      associationSet: aspAssociationSet('http://127.0.0.1:28402'),
      store: new MemoryStore(),
      policy: { budget: 1_000_000n, maxPayments: 20, maxAgeSeconds: 3600, maxPaymentAmount: 100_000n },
      now: () => Math.floor(Date.now() / 1000) + offset,
    });

    const server = createSodiMcpServer(client, {
      maxTotalSpend: 50_000n,
      allowedHosts: [],
      recycle: () => client.recycleSessions({ submitter: relayer.recycleSubmitter({ recycler, maxFee: 5_000n }) }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    mcp = new Client({ name: 'test-agent', version: '1.0.0' });
    await mcp.connect(clientTransport);
    call = (name, args = {}) => mcp.callTool({ name, arguments: args }) as Promise<ToolResult>;
  }, 120_000);

  afterAll(async () => {
    await mcp?.close();
    for (const s of servers) s.close();
  });

  it('exposes the rx402 tools', async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['rx402_deposit', 'rx402_fetch', 'rx402_open_session', 'rx402_recycle', 'rx402_status']);
  });

  it('deposits through the MCP tool, then the approval service approves it', async () => {
    const r = parse(await call('rx402_deposit', { amount_usdg: '3' }));
    expect(r.depositedUsdg).toBe('3');
    const cycle = await runCycle({
      publicClient,
      walletClient: wallet(privateKeyToAccount(POSTMAN_KEY)),
      entrypoint: ENTRYPOINT,
      pools: [POOL],
      policy: { blockedAddresses: new Set(), deniedLabels: new Set(), vettingDelaySeconds: 0 },
      state: aspState,
      stateFile: join(dir, 'state.json'),
      setsDir: join(dir, 'sets'),
      logChunkSize: 50_000,
      dryRun: false,
    });
    expect(cycle.approved).toBeGreaterThan(0);
    expect(parse(await call('rx402_status')).poolBalanceUsdg).toBe('3');
  }, 180_000);

  it('pays an x402 API privately, with the session funded through the HTTP relayer', async () => {
    const r = parse(await call('rx402_fetch', { url: 'http://127.0.0.1:28404/weather' }));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ data: 'paid content for /weather' });
    expect(r.payment.paidUsdg).toBe('0.01');
    expect(r.payment.fromSession).not.toBe(owner.address);

    // Relayer took its 0.5% fee; the session got the rest.
    expect(await balance(relayerAcct.address)).toBe(5_000n);
    expect(await balance(r.payment.fromSession)).toBe(995_000n - 10_000n);
    expect(await balance(MERCHANT)).toBe(10_000n);

    const status = parse(await call('rx402_status'));
    expect(status.poolBalanceUsdg).toBe('2');
    expect(status.session.payments).toBe(1);
    expect(status.limits.spentThisRunUsdg).toBe('0.01');
  }, 600_000);

  it('respects a per-call price cap', async () => {
    const r = await call('rx402_fetch', { url: 'http://127.0.0.1:28404/news', max_price_usdg: '0.02' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/above the cap/);
    expect(await balance(MERCHANT)).toBe(10_000n);
  }, 60_000);

  it('pays an x402 v2 API from the same session', async () => {
    const r = parse(await call('rx402_fetch', { url: 'http://127.0.0.1:28404/news' }));
    expect(r.status).toBe(200);
    expect(r.payment.paidUsdg).toBe('0.025');
    expect(await balance(MERCHANT)).toBe(35_000n);
  }, 60_000);

  it('stops paying once the run spending limit is reached', async () => {
    // 0.035 spent of 0.05; the next 0.025 payment would exceed the limit.
    const r = await call('rx402_fetch', { url: 'http://127.0.0.1:28404/news' });
    expect(r.isError).toBe(true);
    expect(await balance(MERCHANT)).toBe(35_000n);
    // Free requests still work.
    const free = parse(await call('rx402_fetch', { url: 'http://127.0.0.1:28404/not-a-paid-route' }));
    expect(free.status).toBe(404);
    expect(free.payment).toBeNull();
  }, 60_000);

  it('rejects a relay request with the wrong fee recipient', async () => {
    const res = await fetch('http://127.0.0.1:28403/relay', {
      method: 'POST',
      body: JSON.stringify({ withdrawal: { processooor: ENTRYPOINT, data: '0x00' }, proof: { pB: [] }, scope: '1' }),
    });
    expect(res.status).toBe(400);
  });

  it('recycles a finished session back into the pool through the tool, once it is safe to', async () => {
    const first = parse(await call('rx402_status')).session.address as Address;
    // Rotate: the first session is no longer current.
    parse(await call('rx402_open_session'));
    const early = parse(await call('rx402_recycle'));
    expect(early.recycled).toEqual([]);
    expect(early.note).toMatch(/nothing to recycle yet/);

    offset = 700; // its payment authorizations have expired by now
    const before = parse(await call('rx402_status')).poolBalanceUsdg;
    const r = parse(await call('rx402_recycle'));
    expect(r.recycled).toEqual([{ session: first, amountUsdg: '0.96', tx: expect.any(String) }]);
    expect(await balance(first)).toBe(0n);
    expect(Number(parse(await call('rx402_status')).poolBalanceUsdg) - Number(before)).toBeCloseTo(0.959, 6);
    expect(parse(await call('rx402_recycle')).recycled).toEqual([]);
  }, 600_000);
});
