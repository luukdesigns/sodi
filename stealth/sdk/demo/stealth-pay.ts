/**
 * Live stealth x402 payments on Robinhood Chain testnet.
 *
 *   A merchant publishes its stealth meta-address in the ERC-6538 registry and offers stealth on its
 *   x402 endpoint. An agent session pays it three times, each to a fresh one-time address. The merchant
 *   finds all three from on-chain announcements, then sweeps them without the stealth addresses ever
 *   holding gas. The merchant's public address receives nothing.
 *
 *   The agent side uses rx402's x402 functions, as an rx402 session would. The session is funded with
 *   a test dollar (TestDollar3009) rather than from the pool, since testnet USDG is scarce.
 *
 * Environment: RELAYER_PRIVATE_KEY (pays gas as facilitator), MERCHANT_PRIVATE_KEY, SETTLER, TOKEN.
 */
import {
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  parseAbi,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { paymentHeader, parsePaymentRequired, selectRequirement, signAuthorization } from '../../../packages/rx402/src/x402.js';
import {
  StealthMerchant,
  StealthReceiver,
  deriveStealthKeys,
  lookupMetaAddress,
  readStealthOffer,
  registerMetaAddress,
  stealthRecipient,
  viewingOnly,
} from '../src/index.js';
import { startStealthMerchant } from './shop.js';

const need = (n: string) => {
  if (!process.env[n]) throw new Error(`set ${n}`);
  return process.env[n] as Hex;
};
const rpcUrl = process.env.RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';
const chainId = await createPublicClient({ transport: http(rpcUrl) }).getChainId();
const chain = defineChain({ id: chainId, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
const wallet = (k: Hex) => createWalletClient({ chain, account: privateKeyToAccount(k), transport: http(rpcUrl) });

const SETTLER = need('SETTLER') as Address;
const TOKEN = need('TOKEN') as Address;
const DOMAIN = { name: 'Sodi Test Dollar', version: '1' };
const PRICE = 50_000n; // 0.05 tUSD
const token = parseAbi(['function mint(address,uint256)', 'function balanceOf(address) view returns (uint256)']);
const bal = (a: Address) => publicClient.readContract({ address: TOKEN, abi: token, functionName: 'balanceOf', args: [a] });
const usd = (v: bigint) => `${formatUnits(v, 6)} tUSD`;
const short = (a: string) => `${a.slice(0, 10)}…`;

const facilitator = wallet(need('RELAYER_PRIVATE_KEY'));
const merchantWallet = wallet(need('MERCHANT_PRIVATE_KEY'));
const merchantAddress = merchantWallet.account.address;

console.log('1. The merchant derives stealth keys from its wallet and publishes its meta-address (ERC-6538)');
const keys = await deriveStealthKeys(merchantWallet);
const merchant = new StealthMerchant(keys, SETTLER);
if ((await lookupMetaAddress(publicClient, merchantAddress)) !== merchant.metaAddress) {
  console.log(`   registered in ${await registerMetaAddress(merchantWallet, publicClient, merchant.metaAddress)}`);
}
console.log(`   ${merchantAddress} -> ${merchant.metaAddress.slice(0, 26)}…`);
const startBlock = await publicClient.getBlockNumber({ cacheTime: 0 });

console.log('2. Its x402 endpoint offers stealth; its server holds only the viewing key');
const shop = startStealthMerchant({
  port: 18480,
  asset: TOKEN,
  payTo: merchantAddress,
  receiver: new StealthReceiver(viewingOnly(keys), SETTLER),
  facilitator,
  publicClient,
  price: PRICE,
  chainId,
  domain: DOMAIN,
});

console.log('3. An agent session pays three times');
const session = privateKeyToAccount(generatePrivateKey());
await publicClient.waitForTransactionReceipt({
  hash: await facilitator.writeContract({ address: TOKEN, abi: token, functionName: 'mint', args: [session.address, 1_000_000n] }),
});
for (let i = 1; i <= 3; i++) {
  const first = await fetch('http://127.0.0.1:18480/stealth');
  const required = await parsePaymentRequired(first);
  const requirement = selectRequirement(required, chainId, TOKEN, PRICE);
  const { to, nonce, proof } = stealthRecipient(readStealthOffer(requirement.extra)!);
  const signed = await signAuthorization(session, requirement, chainId, undefined, to, { nonce, receive: true });
  const [name, value] = paymentHeader(required.version, requirement, signed, proof);
  const res = await fetch('http://127.0.0.1:18480/stealth', { headers: { [name]: value } });
  if (res.status !== 200) throw new Error(await res.text());
  console.log(`   payment ${i}: ${usd(PRICE)} to ${proof.stealthAddress}  (${shop.settled.at(-1)!.txHash})`);
}
shop.server.close();
console.log(`   merchant's public address received: ${usd(await bal(merchantAddress))}`);

console.log('4. The merchant finds its payments from the chain alone');
const found = await merchant.scan(publicClient, { fromBlock: startBlock, tokens: [TOKEN] });
for (const f of found) console.log(`   ${f.stealthAddress}  ${usd(f.amount ?? 0n)}  block ${f.blockNumber}`);

console.log('5. And sweeps them; the stealth addresses never need gas');
const vault = privateKeyToAccount(generatePrivateKey()).address;
const swept = await merchant.sweep({ publicClient, gasPayer: facilitator, payments: found, token: TOKEN, domain: DOMAIN, to: vault });
for (const s of swept) console.log(`   ${short(s.stealthAddress)} -> vault ${usd(s.amount)}  (${s.txHash})`);
console.log(`   vault ${vault} holds ${usd(await bal(vault))}`);
