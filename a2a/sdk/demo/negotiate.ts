/**
 * Sealed-bid negotiation between AI agents, entirely on a public chain.
 *
 *   Atlas (buyer) asks three sellers for a quote. Each seller bids privately to Atlas only, so no
 *   seller ever sees a competitor's price. Atlas awards the job and tells the others. Eve, an outside
 *   agent watching every transaction, sees only who posted and how big each envelope is.
 *
 * Agents hold no gas: they sign, and a relayer submits. Run:
 *   RPC_URL=... A2A_CONTRACT=0x... RELAYER_PRIVATE_KEY=0x... npx tsx demo/negotiate.ts
 */
import {
  type Address,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { sodiA2AAbi } from '../src/abi.js';
import { A2AClient, type Message, WalletPostRelayer } from '../src/client.js';

export interface DemoResult {
  channelId: bigint;
  winner: string;
  views: Record<string, string[]>;
  onChain: { author: string; channelId: bigint; bytes: number; tx: string }[];
  outsiderPostRejected: boolean;
  transactions: string[];
}

export async function runDemo(opts: {
  publicClient: PublicClient;
  relayerWallet: WalletClient;
  contract: Address;
  log?: (m: string) => void;
}): Promise<DemoResult> {
  const log = opts.log ?? console.log;
  const { publicClient, relayerWallet, contract } = opts;
  const relayer = new WalletPostRelayer(relayerWallet, publicClient, contract);
  const chain = relayerWallet.chain;
  const transport = http(publicClient.transport.url as string);
  const startBlock = await publicClient.getBlockNumber();
  const txs: string[] = [];

  const make = (name: string) => {
    const wallet = createWalletClient({ chain, account: privateKeyToAccount(generatePrivateKey()), transport });
    return { name, client: new A2AClient({ publicClient, wallet, contract, relayer }) };
  };
  const atlas = make('Atlas');
  const sellers = [make('Bolt'), make('Cinder'), make('Drift')];
  const eve = make('Eve');
  const everyone = [atlas, ...sellers, eve];
  const nameOf = (a: Address) => everyone.find((x) => x.client.address === a)?.name ?? a;

  log('1. Agents derive keys from a wallet signature and register them (gasless, via relayer)');
  for (const a of everyone) {
    await a.client.init();
    const tx = await a.client.register();
    if (tx) txs.push(tx);
    log(`   ${a.name.padEnd(6)} ${a.client.address}  key ${a.client.publicKey.slice(0, 18)}…`);
  }

  log('2. Coordinator opens a restricted channel; only the buyer and sellers may post');
  const createHash = await relayerWallet.writeContract({
    address: contract,
    abi: sodiA2AAbi,
    functionName: 'createChannel',
    args: [true, [atlas, ...sellers].map((a) => a.client.address)],
    account: relayerWallet.account!,
    chain,
  });
  txs.push(createHash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  const channelId = BigInt(receipt.logs.find((l) => l.address.toLowerCase() === contract.toLowerCase())!.topics[1]!);
  log(`   channel #${channelId}`);

  log('3. Atlas sends one request for quotes, encrypted to all three sellers');
  const rfq = { job: 'Fine-tune a 7B model', gpuHours: 40, currency: 'USDG', closesInSeconds: 600 };
  txs.push(await atlas.client.send({ to: sellers.map((s) => s.client.address), channelId, type: 'rfq', body: rfq }));

  log('4. Each seller reads the request and bids privately to Atlas only');
  const prices: Record<string, number> = { Bolt: 0.52, Cinder: 0.47, Drift: 0.49 };
  for (const s of sellers) {
    const inbox = await s.client.inbox({ fromBlock: startBlock, channelIds: [channelId] });
    const request = inbox.find((m) => m.type === 'rfq');
    if (!request) throw new Error(`${s.name} did not receive the RFQ`);
    const bid = { pricePerGpuHour: prices[s.name], total: +(prices[s.name]! * rfq.gpuHours).toFixed(2), slaHours: 12 };
    txs.push(await s.client.send({ to: [atlas.client.address], channelId, type: 'bid', body: bid, ref: request.id }));
    log(`   ${s.name.padEnd(6)} bid ${bid.pricePerGpuHour} USDG/GPU-hour`);
  }

  log('5. Atlas opens the bids, awards the lowest, and tells the others in one message');
  const bids = (await atlas.client.inbox({ fromBlock: startBlock, channelIds: [channelId] })).filter(
    (m): m is Message<{ pricePerGpuHour: number; total: number }> => m.type === 'bid',
  );
  if (bids.length !== 3) throw new Error(`Atlas expected 3 bids, got ${bids.length}`);
  const best = bids.reduce((a, b) => (b.body.pricePerGpuHour < a.body.pricePerGpuHour ? b : a));
  const losers = bids.filter((b) => b !== best).map((b) => b.from);
  txs.push(
    await atlas.client.send({
      to: [best.from],
      channelId,
      type: 'award',
      body: { accepted: best.body, payWith: 'rx402' },
      ref: best.id,
    }),
  );
  txs.push(await atlas.client.send({ to: losers, channelId, type: 'not-selected', body: { thanks: true } }));
  log(`   awarded to ${nameOf(best.from)} at ${best.body.pricePerGpuHour} USDG/GPU-hour`);

  log('6. What each agent can read');
  const views: Record<string, string[]> = {};
  for (const a of everyone) {
    const msgs = await a.client.inbox({ fromBlock: startBlock });
    views[a.name] = msgs.map((m) => `${nameOf(m.from)}:${m.type}${m.type === 'bid' ? `@${(m.body as { pricePerGpuHour: number }).pricePerGpuHour}` : ''}`);
    log(`   ${a.name.padEnd(6)} ${views[a.name]!.length ? views[a.name]!.join(', ') : '(nothing)'}`);
  }

  log('7. What anyone watching the chain sees');
  const logs = await publicClient.getContractEvents({
    address: contract,
    abi: sodiA2AAbi,
    eventName: 'Posted',
    fromBlock: startBlock,
  });
  const onChain = logs.map((l) => ({
    author: nameOf(l.args.author!),
    channelId: l.args.channelId!,
    bytes: (l.args.envelope!.length - 2) / 2,
    tx: l.transactionHash,
  }));
  for (const l of logs) {
    log(`   #${l.args.channelId} ${nameOf(l.args.author!).padEnd(6)} ${(l.args.envelope!.length - 2) / 2} bytes  ${l.args.envelope!.slice(0, 42)}…`);
  }

  log('8. Eve tries to post into the restricted channel');
  let outsiderPostRejected = false;
  try {
    await eve.client.send({ to: [atlas.client.address], channelId, type: 'bid', body: { pricePerGpuHour: 0.01 } });
  } catch {
    outsiderPostRejected = true;
  }
  log(`   ${outsiderPostRejected ? 'rejected by the contract (not on the whitelist)' : 'ACCEPTED: unexpected'}`);

  return { channelId, winner: nameOf(best.from), views, onChain, outsiderPostRejected, transactions: txs };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rpcUrl = process.env.RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';
  const contract = process.env.A2A_CONTRACT as Address;
  const key = process.env.RELAYER_PRIVATE_KEY as `0x${string}`;
  if (!contract || !key) throw new Error('set A2A_CONTRACT and RELAYER_PRIVATE_KEY');
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  const chain = defineChain({
    id: chainId,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const result = await runDemo({
    publicClient: createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient,
    relayerWallet: createWalletClient({ chain, account: privateKeyToAccount(key), transport: http(rpcUrl) }),
    contract,
  });
  console.log(`\n${result.transactions.length} transactions; winner ${result.winner}`);
}
