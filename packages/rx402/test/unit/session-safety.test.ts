/**
 * Session safety against a simulated chain: withdrawals that land after the relayer reports an
 * error, relayers that lie, proofs landed late, and concurrent payments.
 */
import { createServer } from 'node:http';

import {
  type Address,
  type Hex,
  type PublicClient,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiItem,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MemoryControls,
  MemoryStore,
  PaymentBlockedError,
  Rx402Client,
  commitmentHash,
  depositSecrets,
  generateMasterKeys,
  merkleProof,
  nullifierHash,
  sessionPrivateKey,
} from '../../src/index.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const POOL = '0x00000000000000000000000000000000000000b1' as Address;
const ENTRYPOINT = '0x00000000000000000000000000000000000000e1' as Address;
const ASSET = '0x00000000000000000000000000000000000000a5' as Address;
const SCOPE = 77n;
const VALUE = 10_000_000n;
const keys = generateMasterKeys(MNEMONIC);

const withdrawnEvent = parseAbiItem('event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)');
const relayedEvent = parseAbiItem(
  'event WithdrawalRelayed(address indexed _relayer, address indexed _recipient, address indexed _asset, uint256 _amount, uint256 _feeAmount)',
);

/** A pool that applies withdrawals the way the real one does, as far as the client can tell. */
function fakeChain(labels: bigint[]) {
  const leaves: bigint[] = [];
  const spent = new Set<bigint>();
  const withdrawals: { args: Record<string, unknown>; transactionHash: Hex; blockNumber: bigint; logIndex: number }[] = [];
  const receipts = new Map<Hex, { status: 'success'; logs: unknown[] }>();
  const balances = new Map<string, bigint>();
  let block = 10n;
  for (const [i, label] of labels.entries()) leaves.push(commitmentHash(VALUE, label, depositSecrets(keys, SCOPE, BigInt(i))));
  const aspRoot = (approved: bigint[]) => merkleProof(approved, approved[0]!).root;
  let approved = labels;

  const apply = (withdrawal: { data: Hex }, proof: { pubSignals: bigint[] }) => {
    const [newCommitment, nullifier, value] = proof.pubSignals as [bigint, bigint, bigint];
    if (spent.has(nullifier)) throw new Error('NullifierAlreadySpent');
    spent.add(nullifier);
    leaves.push(newCommitment);
    const [[recipient, , fee]] = decodeAbiParameters([{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] }], withdrawal.data) as [[Address, Address, bigint]];
    const feeAmount = (value * fee) / 10_000n;
    balances.set(recipient.toLowerCase(), (balances.get(recipient.toLowerCase()) ?? 0n) + value - feeAmount);
    const txHash = toHex(block, { size: 32 });
    block++;
    withdrawals.push({ args: { _value: value, _spentNullifier: nullifier, _newCommitment: newCommitment }, transactionHash: txHash, blockNumber: block, logIndex: 0 });
    receipts.set(txHash, {
      status: 'success',
      logs: [
        {
          address: ENTRYPOINT,
          topics: encodeEventTopics({ abi: [relayedEvent], args: { _relayer: ENTRYPOINT, _recipient: recipient, _asset: ASSET } }),
          data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [value, feeAmount]),
        },
      ],
    });
    return txHash;
  };

  const publicClient = {
    getChainId: async () => 46630,
    getBlockNumber: async () => block,
    getLogs: async ({ event }: { event: { name: string } }) =>
      event.name === 'Deposited'
        ? labels.map((_, i) => ({ args: { _commitment: leaves[i] }, blockNumber: 1n, logIndex: i }))
        : event.name === 'Withdrawn'
          ? withdrawals
          : [],
    readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      if (functionName === 'SCOPE') return SCOPE;
      if (functionName === 'latestRoot') return aspRoot(approved);
      if (functionName === 'nullifierHashes') return spent.has(args![0] as bigint);
      if (functionName === 'balanceOf') return balances.get(String(args![0]).toLowerCase()) ?? 0n;
      throw new Error(`unexpected read ${functionName}`);
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const r = receipts.get(hash);
      if (!r) throw new Error('receipt not found');
      return r;
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const r = receipts.get(hash);
      if (!r) throw new Error('timed out');
      return r;
    },
  } as unknown as PublicClient;

  return { publicClient, apply, spent, setApproved: (l: bigint[]) => (approved = l) };
}

/** A prover that outputs the public signals the real circuit would. */
const prover = {
  prove: async (i: { withdrawnValue: bigint; existingValue: bigint; label: bigint; existing: { nullifier: bigint }; next: { nullifier: bigint; secret: bigint } }) => ({
    proof: { pubSignals: [commitmentHash(i.existingValue - i.withdrawnValue, i.label, i.next), nullifierHash(i.existing.nullifier), i.withdrawnValue] },
    publicSignals: [],
  }),
};

function setup(opts: { relay: (apply: (w: { data: Hex }, p: { pubSignals: bigint[] }) => Hex, w: { data: Hex }, p: { pubSignals: bigint[] }) => Promise<Hex>; labels?: bigint[] }) {
  const labels = opts.labels ?? [12345n];
  const chain = fakeChain(labels);
  const store = new MemoryStore();
  store.save({
    version: 1,
    notes: labels.map((l, i) => ({ scope: SCOPE.toString(), depositIndex: i, label: l.toString(), value: VALUE.toString(), spendCount: 0, depositTx: '0x01' })),
    depositCounts: { [SCOPE.toString()]: labels.length },
    sessions: [],
  });
  const controls = new MemoryControls();
  const client = new Rx402Client({
    publicClient: chain.publicClient,
    mnemonic: MNEMONIC,
    entrypoint: ENTRYPOINT,
    pool: POOL,
    asset: ASSET,
    poolDeploymentBlock: 0n,
    relayer: { feeRecipient: ENTRYPOINT, relayFeeBPS: 50n, relay: (w, p) => opts.relay(chain.apply, w as never, p as never) },
    prover: prover as never,
    associationSet: async () => labels,
    store,
    controls,
    policy: { budget: 1_000_000n, maxPayments: 10, maxAgeSeconds: 3600, maxPaymentAmount: 100_000n },
  });
  return { client, store, controls, chain };
}

describe('opening sessions', () => {
  it('keeps a session whose withdrawal landed even though the relayer reported an error', async () => {
    const { client, store } = setup({
      relay: async (apply, w, p) => {
        apply(w, p);
        throw new Error('relayer: internal error');
      },
    });
    const s = await client.openSession();
    expect(s.address).toBe(privateKeyToAccount(sessionPrivateKey(keys, 12345n, 0n)).address);
    expect(BigInt(s.budget)).toBe(1_000_000n - 5_000n);
    expect(store.load().notes[0]).toMatchObject({ spendCount: 1, value: (VALUE - 1_000_000n).toString() });
    // The wallet keeps working: the next session spends the change commitment.
    expect((await client.openSession()).address).toBe(privateKeyToAccount(sessionPrivateKey(keys, 12345n, 1n)).address);
  });

  it('does not believe a relayer that reports a transaction it never sent', async () => {
    let honest = false;
    const { client, store } = setup({ relay: async (apply, w, p) => (honest ? apply(w, p) : (`0x${'de'.repeat(32)}` as Hex)) });
    await expect(client.openSession()).rejects.toThrow(/did not land/);
    expect(store.load().notes[0]).toMatchObject({ spendCount: 0, value: VALUE.toString() });
    expect(store.load().sessions).toHaveLength(0);
    honest = true;
    expect((await client.openSession()).payments).toBe(0);
  });

  it('recovers a session from a proof the relayer held and landed later', async () => {
    let held: (() => Hex) | undefined;
    let mode: 'hold' | 'honest' = 'hold';
    const { client, store } = setup({
      relay: async (apply, w, p) => {
        if (mode === 'hold') {
          held = () => apply(w, p);
          throw new Error('timeout');
        }
        return apply(w, p);
      },
    });
    await expect(client.openSession()).rejects.toThrow(/did not land/);
    held!(); // the relayer lands the old proof after all
    mode = 'honest';
    const s = await client.openSession();
    const sessions = store.load().sessions;
    expect(sessions.map((x) => x.address)).toEqual([
      privateKeyToAccount(sessionPrivateKey(keys, 12345n, 0n)).address,
      privateKeyToAccount(sessionPrivateKey(keys, 12345n, 1n)).address,
    ]);
    expect(s.address).toBe(sessions[1]!.address);
    expect(store.load().notes[0]!.spendCount).toBe(2);
  });

  it('honours the kill switch and the budget limit', async () => {
    const { client, controls } = setup({ relay: async (apply, w, p) => apply(w, p) });
    controls.save({ paused: true });
    await expect(client.openSession()).rejects.toBeInstanceOf(PaymentBlockedError);
    controls.save({ paused: false });
    await expect(client.openSession(VALUE)).rejects.toThrow(/session budget must be/);
  });

  it('skips deposits that are not approved', async () => {
    const { client, chain, store } = setup({ relay: async (apply, w, p) => apply(w, p), labels: [111n, 222n] });
    chain.setApproved([222n]);
    (client as unknown as { config: { associationSet: () => Promise<bigint[]> } }).config.associationSet = async () => [222n];
    await client.openSession();
    expect(store.load().notes.map((n) => n.spendCount)).toEqual([0, 1]);
  });
});

describe('paying', () => {
  const PORT = 18631;
  let server: ReturnType<typeof createServer>;
  let mode: 'ok' | 'error' = 'ok';
  beforeAll(() => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/redirect') return void res.writeHead(302, { location: `http://localhost:${PORT}/item` }).end();
      if (req.headers['x-payment']) return void res.writeHead(mode === 'ok' ? 200 : 500).end(mode);
      res.writeHead(402, { 'content-type': 'application/json' }).end(
        JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'robinhood-testnet', asset: ASSET, payTo: POOL, maxAmountRequired: '10000', maxTimeoutSeconds: 3600 }] }),
      );
    });
    server.listen(PORT);
  });
  afterAll(() => server.close());
  const url = (p: string) => `http://127.0.0.1:${PORT}${p}`;

  it('counts a payment the merchant answered with an error', async () => {
    const { client, controls, store } = setup({ relay: async (apply, w, p) => apply(w, p) });
    controls.save({ paused: false, dailyLimit: '20000' });
    mode = 'error';
    const r = await client.fetch(url('/item'));
    expect(r.payment?.accepted).toBe(false);
    await client.fetch(url('/item'));
    await expect(client.fetch(url('/item'))).rejects.toBeInstanceOf(PaymentBlockedError);
    expect(store.load().payments!.map((p) => p.status)).toEqual(['refused', 'refused']);
    mode = 'ok';
  });

  it('runs concurrent payments one at a time, so limits and sessions hold', async () => {
    const { client, controls, store } = setup({ relay: async (apply, w, p) => apply(w, p) });
    controls.save({ paused: false, dailyLimit: '30000' });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => client.fetch(url('/item'))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const state = store.load();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({ spent: '30000', payments: 3 });
    expect(state.notes[0]!.spendCount).toBe(1);
  });

  it('checks the allowed hosts against the server that asks for payment, after redirects', async () => {
    const { client, controls } = setup({ relay: async (apply, w, p) => apply(w, p) });
    controls.save({ paused: false, allowedHosts: [`127.0.0.1:${PORT}`] });
    await expect(client.fetch(url('/redirect'))).rejects.toThrow(/localhost:18631 is not on the allowed list/);
    expect((await client.fetch(url('/item'))).payment?.accepted).toBe(true);
  });
});
