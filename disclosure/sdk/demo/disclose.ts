/**
 * Live disclosure on Robinhood Chain testnet.
 *
 *   Orion has private activity across Sodi: an ERC-8183 job (#1, from the privacy-hook demo), memory
 *   slots and A2A messages. Orion shows an auditor, Ada, exactly the job, the trade log and the deal
 *   thread with Bob, and nothing else. Then Orion grants Ada ongoing access to the trade log, and revokes it.
 *
 *   RELAYER_PRIVATE_KEY (Orion, who also relays) and the contract addresses come from the environment.
 */
import { A2AClient, WalletPostRelayer } from '@sodi/a2a';
import { AgentMemory, WalletMemoryRelayer } from '@sodi/memory';
import { type Address, type Hex, type PublicClient, createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { Auditor, Discloser, StandingGrants, memoryScope } from '../src/index.js';

const need = (n: string) => {
  if (!process.env[n]) throw new Error(`set ${n}`);
  return process.env[n] as Hex;
};
const rpcUrl = process.env.RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';
const p0 = createPublicClient({ transport: http(rpcUrl) });
const chain = defineChain({ id: await p0.getChainId(), name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
const wallet = (k: Hex) => createWalletClient({ chain, account: privateKeyToAccount(k), transport: http(rpcUrl) });

const registry = need('REGISTRY') as Address;
const memoryContract = need('MEMORY_CONTRACT') as Address;
const hook = need('HOOK') as Address;
const jobId = BigInt(need('JOB_ID'));
const jobFromBlock = BigInt(need('JOB_FROM_BLOCK'));
const memoryFromBlock = BigInt(need('MEMORY_FROM_BLOCK'));

const orionW = wallet(need('RELAYER_PRIVATE_KEY'));
const relayA2A = new WalletPostRelayer(orionW, publicClient, registry);
const id = async (w: ReturnType<typeof wallet>) => {
  const c = new A2AClient({ publicClient, wallet: w, contract: registry, relayer: relayA2A });
  await c.init();
  await c.register();
  return c;
};
const start = await publicClient.getBlockNumber();
const orion = await id(orionW);
const bob = await id(wallet(generatePrivateKey()));
const carol = await id(wallet(generatePrivateKey()));
const ada = await id(wallet(generatePrivateKey()));
console.log(`Orion ${orion.address}\nAuditor Ada ${ada.address}`);

console.log('1. Orion has private activity: a deal thread with Bob, a personal chat with Carol, two memory slots, and job #1');
await orion.send({ to: [bob.address], type: 'deal', body: { with: 'bob', text: 'Offer: 100 GPU-hours at 0.45 tUSD' } });
await bob.send({ to: [orion.address], type: 'deal', body: { with: 'orion', text: 'Accepted' } });
await orion.send({ to: [carol.address], type: 'chat', body: { with: 'carol', text: 'Personal: dinner Friday?' } });
const memory = new AgentMemory({ publicClient, wallet: orionW, contract: memoryContract, fromBlock: memoryFromBlock, relayer: new WalletMemoryRelayer(orionW, publicClient, memoryContract) });
await memory.init();
await memory.set('trades', [{ id: 1, side: 'buy', symbol: 'NVDA', qty: 10 }]);
await memory.update('trades', (t: unknown[] | undefined) => [...(t ?? []), { id: 2, side: 'sell', symbol: 'TSLA', qty: 4 }]);
await memory.set('personal', { note: 'not for auditors' });

console.log('2. Orion discloses the Bob thread, the trade log and job #1 to Ada, and nothing else');
const discloser = new Discloser(publicClient, orion);
const items = [
  ...(await discloser.collectMessages({ contract: registry, channelId: 0n, fromBlock: start, filter: (m) => (m.body as { with?: string }).with !== 'carol' })),
  ...(await discloser.collectMemory(memory, memoryContract, 'trades')),
  ...(await discloser.collectJob({ hook, jobId, fromBlock: jobFromBlock })),
];
const grantTxs = await discloser.send({ auditor: ada.address, note: 'Q4 review: Bob deal, trade log, security review job #1', items });
console.log(`   ${items.length} items, sent in ${grantTxs[0]}`);

console.log('3. Ada reads the grant and checks every item against the chain');
const auditor = new Auditor(publicClient, ada, undefined, { a2a: [registry], memory: [memoryContract], erc8183Hooks: [hook], pools: [] });
const [grant] = await auditor.grants(start);
const { records, failures } = await auditor.readGrant(grant!);
for (const r of records) console.log(`   ${r.kind.padEnd(20)} by ${r.author.slice(0, 10)}…  ${JSON.stringify(r.data).slice(0, 70)}`);
console.log(`   failures: ${failures.length}; mentions Carol or the personal slot: ${/dinner|not for auditors/.test(JSON.stringify(records)) ? 'YES' : 'no'}`);

console.log('4. Standing access: Ada may read future trade-log writes, until revoked');
const standing = new StandingGrants(memory, orion);
const scope = memoryScope(memory.slotId('trades'));
await standing.grant(ada.address, scope, 'ongoing trade log access');
let cur = (await memory.get<unknown[]>('trades'))!;
await memory.set('trades', [...cur.value, { id: 3, side: 'buy', symbol: 'AAPL', qty: 2 }], { shareWith: await standing.readersFor(scope), expectedVersion: cur.version });
await standing.revoke(ada.address, scope);
cur = (await memory.get<unknown[]>('trades'))!;
await memory.set('trades', [...cur.value, { id: 4, side: 'sell', symbol: 'NVDA', qty: 5 }], { shareWith: await standing.readersFor(scope), expectedVersion: cur.version });
const visible = await auditor.readStandingMemory(memoryContract, orion.address, memory.slotId('trades'), start);
console.log(`   Ada can read trade-log versions: ${visible.map((v) => `v${v.version}`).join(', ')} (granted while active; nothing after revoke)`);
