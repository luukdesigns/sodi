import { createServer, type Server } from 'node:http';

import { type Address, type PublicClient, type WalletClient, parseAbi, parseSignature } from 'viem';

/**
 * Minimal x402 merchant + facilitator for tests: answers 402 with USDG requirements, then
 * settles the signed EIP-3009 authorization on-chain with `transferWithAuthorization`.
 */
const usdgAbi = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
]);

export interface Settlement {
  path: string;
  from: Address;
  value: bigint;
  txHash: `0x${string}`;
}

export function startMerchant(opts: {
  port: number;
  asset: Address;
  payTo: Address;
  facilitator: WalletClient;
  publicClient: PublicClient;
  prices: Record<string, { amount: bigint; version: 1 | 2 }>;
}): { server: Server; settlements: Settlement[] } {
  const settlements: Settlement[] = [];
  const server = createServer(async (req, res) => {
    const path = req.url ?? '/';
    const price = opts.prices[path];
    if (!price) {
      res.writeHead(404).end();
      return;
    }
    const requirement = {
      scheme: 'exact',
      network: price.version === 2 ? 'eip155:46630' : 'robinhood-testnet',
      asset: opts.asset,
      payTo: opts.payTo,
      maxTimeoutSeconds: 300,
      extra: { name: 'Global Dollar', version: '1' },
      ...(price.version === 2 ? { amount: price.amount.toString() } : { maxAmountRequired: price.amount.toString(), resource: path }),
    };
    const header = req.headers[price.version === 2 ? 'payment-signature' : 'x-payment'] as string | undefined;

    if (!header) {
      const body = { x402Version: price.version, error: 'payment required', accepts: [requirement] };
      res.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      return;
    }

    try {
      const { payload } = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
      const a = payload.authorization;
      if (a.to.toLowerCase() !== opts.payTo.toLowerCase() || BigInt(a.value) < price.amount) {
        throw new Error('authorization does not match the price');
      }
      const { v, r, s } = parseSignature(payload.signature);
      const txHash = await opts.facilitator.writeContract({
        address: opts.asset,
        abi: usdgAbi,
        functionName: 'transferWithAuthorization',
        args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v), r, s],
        account: opts.facilitator.account!,
        chain: opts.facilitator.chain,
      });
      const receipt = await opts.publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') throw new Error('settlement reverted');
      settlements.push({ path, from: a.from, value: BigInt(a.value), txHash });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: `paid content for ${path}` }));
    } catch (err) {
      res.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(err) }));
    }
  });
  server.listen(opts.port);
  return { server, settlements };
}
