import { type Address, type Hex, type LocalAccount, toHex } from 'viem';

/**
 * Client side of the x402 `exact` scheme with EIP-3009 (`transferWithAuthorization`).
 * Understands both protocol versions:
 *   v1: requirements in the 402 JSON body (`maxAmountRequired`), payment in `X-PAYMENT`
 *   v2: requirements in the body or `PAYMENT-REQUIRED` header (`amount`, CAIP-2 network),
 *       payment in `PAYMENT-SIGNATURE` with the chosen requirement echoed as `accepted`
 */

export interface PaymentRequirement {
  scheme: string;
  network: string;
  asset: Address;
  payTo: Address;
  amount: bigint;
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string };
  /** The requirement exactly as the server sent it (echoed back in v2). */
  raw: Record<string, unknown>;
}

export interface PaymentRequired {
  version: 1 | 2;
  requirements: PaymentRequirement[];
}

const decodeBase64Json = (s: string) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
const encodeBase64Json = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');

export async function parsePaymentRequired(res: Response): Promise<PaymentRequired> {
  let body: Record<string, unknown>;
  const header = res.headers.get('payment-required');
  if (header) body = decodeBase64Json(header);
  else {
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new Error('402 response has no payment requirements');
    }
  }
  const version = body.x402Version === 2 ? 2 : 1;
  const accepts = (body.accepts ?? []) as Record<string, unknown>[];
  return {
    version,
    requirements: accepts.map((a) => ({
      scheme: String(a.scheme),
      network: String(a.network),
      asset: a.asset as Address,
      payTo: a.payTo as Address,
      amount: BigInt(String(a.amount ?? a.maxAmountRequired ?? '0')),
      maxTimeoutSeconds: Number(a.maxTimeoutSeconds ?? 60),
      extra: a.extra as PaymentRequirement['extra'],
      raw: a,
    })),
  };
}

/** Network identifiers that mean "this chain" (CAIP-2 plus common v1 names). */
export function networkNames(chainId: number): string[] {
  const names = [`eip155:${chainId}`];
  if (chainId === 4663) names.push('robinhood', 'robinhood-chain');
  if (chainId === 46630) names.push('robinhood-testnet', 'robinhood-chain-testnet');
  return names;
}

export function selectRequirement(
  required: PaymentRequired,
  chainId: number,
  asset: Address,
  maxAmount: bigint,
): PaymentRequirement {
  const networks = networkNames(chainId);
  const match = required.requirements.find(
    (r) =>
      r.scheme === 'exact' &&
      networks.includes(r.network) &&
      r.asset.toLowerCase() === asset.toLowerCase() &&
      r.amount > 0n &&
      r.amount <= maxAmount,
  );
  if (!match) {
    throw new Error(`no acceptable payment option (need exact ${asset} on ${networks[0]}, at most ${maxAmount})`);
  }
  return match;
}

export interface Authorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

/** Signs an EIP-3009 transfer authorization from the session account. */
export async function signAuthorization(
  account: LocalAccount,
  requirement: PaymentRequirement,
  chainId: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ authorization: Authorization; signature: Hex }> {
  const authorization: Authorization = {
    from: account.address,
    to: requirement.payTo,
    value: requirement.amount,
    validAfter: 0n,
    validBefore: BigInt(nowSeconds + requirement.maxTimeoutSeconds),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await account.signTypedData({
    domain: {
      // USDG's EIP-712 domain; servers may override via `extra`.
      name: requirement.extra?.name ?? 'Global Dollar',
      version: requirement.extra?.version ?? '1',
      chainId,
      verifyingContract: requirement.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  });
  return { authorization, signature };
}

/** Header name and value carrying the signed payment, for the server's protocol version. */
export function paymentHeader(
  version: 1 | 2,
  requirement: PaymentRequirement,
  signed: { authorization: Authorization; signature: Hex },
): [string, string] {
  const authorization = {
    from: signed.authorization.from,
    to: signed.authorization.to,
    value: signed.authorization.value.toString(),
    validAfter: signed.authorization.validAfter.toString(),
    validBefore: signed.authorization.validBefore.toString(),
    nonce: signed.authorization.nonce,
  };
  const payload = { signature: signed.signature, authorization };
  if (version === 2) {
    return ['PAYMENT-SIGNATURE', encodeBase64Json({ x402Version: 2, accepted: requirement.raw, payload })];
  }
  return [
    'X-PAYMENT',
    encodeBase64Json({ x402Version: 1, scheme: requirement.scheme, network: requirement.network, payload }),
  ];
}
