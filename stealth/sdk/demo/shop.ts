import { createServer, type Server } from 'node:http';

import { type Address, type Hex, type PublicClient, type WalletClient, parseAbi, parseSignature } from 'viem';

import { StealthReceiver, decodePaymentHeader } from '../src/index.js';

/**
 * A minimal x402 merchant and facilitator, used by the demo and the end-to-end test. Two endpoints:
 *   /stealth  offers a stealth address (x402 v2); verifies with the viewing key only and settles
 *             through the SodiStealthSettler
 *   /plain    an ordinary x402 v1 merchant, for comparison
 */
const usdgAbi = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
]);

export interface Settled {
  path: string;
  to: Address;
  value: bigint;
  stealth: boolean;
  txHash: Hex;
}

export function startStealthMerchant(opts: {
  port: number;
  asset: Address;
  payTo: Address;
  receiver: StealthReceiver;
  settler: Address;
  facilitator: WalletClient;
  publicClient: PublicClient;
  price: bigint;
  chainId: number;
  /** The token's EIP-712 domain; USDG's by default. */
  domain?: { name: string; version: string };
}): { server: Server; settled: Settled[] } {
  const settled: Settled[] = [];
  const domain = opts.domain ?? { name: 'Global Dollar', version: '1' };
  const server = createServer(async (req, res) => {
    const path = req.url ?? '/';
    if (path !== '/stealth' && path !== '/plain') return void res.writeHead(404).end();
    const v2 = path === '/stealth';
    const base = {
      scheme: 'exact',
      network: v2 ? `eip155:${opts.chainId}` : 'robinhood-testnet',
      asset: opts.asset,
      payTo: opts.payTo,
      maxTimeoutSeconds: 300,
      extra: domain as Record<string, unknown>,
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
        const verified = await opts.receiver.verify(payment, { asset: opts.asset, amount: opts.price, chainId: opts.chainId, domain });
        txHash = await opts.receiver.settle(opts.facilitator, opts.publicClient, opts.settler, verified);
      } else {
        if (a.to.toLowerCase() !== opts.payTo.toLowerCase() || BigInt(a.value) < opts.price) throw new Error('bad payment');
        const { v, r, s } = parseSignature(payment.payload.signature);
        txHash = await opts.facilitator.writeContract({
          address: opts.asset,
          abi: usdgAbi,
          functionName: 'transferWithAuthorization',
          args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v), r, s],
          account: opts.facilitator.account!,
          chain: opts.facilitator.chain,
        });
        await opts.publicClient.waitForTransactionReceipt({ hash: txHash });
      }
      settled.push({ path, to: a.to, value: BigInt(a.value), stealth: Boolean(payment.payload.stealth), txHash });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: `paid content for ${path}` }));
    } catch (err) {
      res.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(err) }));
    }
  });
  server.listen(opts.port);
  return { server, settled };
}
