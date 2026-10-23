/**
 * Two small x402 APIs the demo agent buys from. Both serve real on-chain data: prices of Robinhood's
 * testnet stock tokens, read from the testnet DEX's pools.
 *
 *   GET /quote/:symbol  one stock's price; offers a stealth address (x402 v2)
 *   GET /market         all five; an ordinary x402 v1 API
 *
 * Each API verifies and settles its own payments, as a merchant with its own facilitator would.
 */
import { type Server, createServer } from 'node:http';

import { StealthReceiver, decodePaymentHeader } from '@sodi/stealth';
import { type Address, type Hex, type PublicClient, type WalletClient, parseAbi, parseSignature } from 'viem';

/** Testnet stock tokens and their 0.3% WETH pools on the testnet DEX (Synthra V3). */
export const STOCKS: Record<string, { token: Address; pool: Address }> = {
  TSLA: { token: '0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e', pool: '0x593e2e0EF3869616Ec3Fbe989dCFf2699D52b69B' },
  AMZN: { token: '0x5884ad2f920c162cfbbacc88c9c51aa75ec09e02', pool: '0x52Da6b2ea089D0FB2054b057a88D8Aa516Cb54C3' },
  PLTR: { token: '0x1fbe1a0e43594b3455993b5de5fd0a7a266298d0', pool: '0x4dAC9Debe44d3aA104ab66f09Debb40C59F4A283' },
  NFLX: { token: '0x3b8262a63d25f0477c4dde23f83cfe22cb768c93', pool: '0x3274D3092aA2e1a9321aB2cB04697C87c5a389b0' },
  AMD: { token: '0x71178bac73cbeb415514eb542a8995b82669778d', pool: '0x51cc359a19dfD16217Cd6C186e1476f78768588D' },
};

const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function token0() view returns (address)',
]);
const eip3009 = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
]);

/** Price of one share in WETH, from the pool's current tick. Both tokens have 18 decimals. */
export async function priceInWeth(publicClient: PublicClient, symbol: string): Promise<number> {
  const s = STOCKS[symbol];
  if (!s) throw new Error(`unknown symbol ${symbol}`);
  const [[sqrtPriceX96], token0] = await Promise.all([
    publicClient.readContract({ address: s.pool, abi: poolAbi, functionName: 'slot0' }),
    publicClient.readContract({ address: s.pool, abi: poolAbi, functionName: 'token0' }),
  ]);
  const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2; // token1 per token0
  return token0.toLowerCase() === s.token.toLowerCase() ? ratio : 1 / ratio;
}

export interface Sale {
  at: number;
  resource: string;
  amount: bigint;
  payer: Address;
  payTo: Address;
  stealth: boolean;
  txHash: Hex;
}

export function startApis(opts: {
  port: number;
  chainId: number;
  asset: Address;
  /** EIP-712 domain of the asset (USDG: Global Dollar / 1). */
  domain: { name: string; version: string };
  price: bigint;
  /** The merchant's public address. */
  payTo: Address;
  receiver: StealthReceiver;
  settler: Address;
  facilitator: WalletClient;
  publicClient: PublicClient;
  onSale?: (s: Sale) => void;
}): Server {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const quote = path.match(/^\/quote\/([A-Z]{2,5})$/);
    if (!(quote && STOCKS[quote[1]!]) && path !== '/market') return void res.writeHead(404).end();
    const v2 = Boolean(quote);
    const base = {
      scheme: 'exact',
      network: v2 ? `eip155:${opts.chainId}` : opts.chainId === 46630 ? 'robinhood-testnet' : 'robinhood',
      asset: opts.asset,
      payTo: opts.payTo,
      maxTimeoutSeconds: 120,
      description: v2 ? `Price of ${quote![1]} in WETH on the testnet DEX` : 'Prices of five testnet stock tokens',
      extra: { ...opts.domain } as Record<string, unknown>,
      ...(v2 ? { amount: opts.price.toString() } : { maxAmountRequired: opts.price.toString(), resource: path }),
    };
    const requirement = v2 ? opts.receiver.offer(base) : base;
    const header = req.headers[v2 ? 'payment-signature' : 'x-payment'] as string | undefined;
    if (!header) {
      return void res
        .writeHead(402, { 'content-type': 'application/json' })
        .end(JSON.stringify({ x402Version: v2 ? 2 : 1, error: 'payment required', accepts: [requirement] }));
    }
    try {
      const payment = decodePaymentHeader(header);
      const a = payment.payload.authorization;
      let txHash: Hex;
      if (payment.payload.stealth) {
        const verified = await opts.receiver.verify(payment, { asset: opts.asset, amount: opts.price, chainId: opts.chainId, domain: opts.domain });
        txHash = await opts.receiver.settle(opts.facilitator, opts.publicClient, opts.settler, verified);
      } else {
        if (a.to.toLowerCase() !== opts.payTo.toLowerCase() || BigInt(a.value) < opts.price) throw new Error('payment does not match the price');
        const { v, r, s } = parseSignature(payment.payload.signature);
        txHash = await opts.facilitator.writeContract({
          address: opts.asset,
          abi: eip3009,
          functionName: 'transferWithAuthorization',
          args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v), r, s],
          account: opts.facilitator.account!,
          chain: opts.facilitator.chain,
        });
        const receipt = await opts.publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== 'success') throw new Error('settlement reverted');
      }
      opts.onSale?.({ at: Math.floor(Date.now() / 1000), resource: path, amount: BigInt(a.value), payer: a.from, payTo: a.to, stealth: Boolean(payment.payload.stealth), txHash });

      const data = quote
        ? { symbol: quote[1], priceInWeth: await priceInWeth(opts.publicClient, quote[1]!) }
        : { prices: Object.fromEntries(await Promise.all(Object.keys(STOCKS).map(async (k) => [k, await priceInWeth(opts.publicClient, k)]))) };
      const receipt = Buffer.from(JSON.stringify({ success: true, transaction: txHash, network: base.network, payer: a.from })).toString('base64');
      res.writeHead(200, { 'content-type': 'application/json', [v2 ? 'payment-response' : 'x-payment-response']: receipt }).end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  server.listen(opts.port, '127.0.0.1');
  return server;
}
