import { hashDomain, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { paymentHeader, parsePaymentRequired, selectRequirement, signAuthorization } from '../../src/x402.js';

const USDG = '0x7E955252E15c84f5768B83c41a71F9eba181802F' as const;
const MERCHANT = '0x000000000000000000000000000000000000bEEF' as const;
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

const v1Body = {
  x402Version: 1,
  error: 'payment required',
  accepts: [
    { scheme: 'exact', network: 'base', asset: '0xusdc', payTo: MERCHANT, maxAmountRequired: '10000', maxTimeoutSeconds: 60 },
    { scheme: 'exact', network: 'robinhood-testnet', asset: USDG, payTo: MERCHANT, maxAmountRequired: '10000', maxTimeoutSeconds: 60, extra: { name: 'Global Dollar', version: '1' } },
  ],
};

const v2Body = {
  x402Version: 2,
  resource: { url: 'https://api.example/data' },
  accepts: [{ scheme: 'exact', network: 'eip155:46630', asset: USDG, payTo: MERCHANT, amount: '25000', maxTimeoutSeconds: 120 }],
};

const decode = (v: string) => JSON.parse(Buffer.from(v, 'base64').toString('utf8'));

describe('parsing payment requirements', () => {
  it('reads v1 bodies (maxAmountRequired)', async () => {
    const req = await parsePaymentRequired(new Response(JSON.stringify(v1Body), { status: 402 }));
    expect(req.version).toBe(1);
    expect(req.requirements[1]!.amount).toBe(10_000n);
  });

  it('reads v2 from the PAYMENT-REQUIRED header (amount, CAIP-2)', async () => {
    const header = Buffer.from(JSON.stringify(v2Body)).toString('base64');
    const req = await parsePaymentRequired(new Response(null, { status: 402, headers: { 'payment-required': header } }));
    expect(req.version).toBe(2);
    expect(req.requirements[0]!.amount).toBe(25_000n);
  });
});

describe('selecting a requirement', () => {
  it('picks the USDG option on this chain and skips others', async () => {
    const req = await parsePaymentRequired(new Response(JSON.stringify(v1Body), { status: 402 }));
    expect(selectRequirement(req, 46630, USDG, 1_000_000n).network).toBe('robinhood-testnet');
  });

  it('refuses payments above the cap', async () => {
    const req = await parsePaymentRequired(new Response(JSON.stringify(v1Body), { status: 402 }));
    expect(() => selectRequirement(req, 46630, USDG, 9_999n)).toThrow(/no acceptable payment option/);
  });

  it('refuses other chains', async () => {
    const req = await parsePaymentRequired(new Response(JSON.stringify(v1Body), { status: 402 }));
    expect(() => selectRequirement(req, 4663, USDG, 1_000_000n)).toThrow();
  });
});

describe('signing', () => {
  it('uses the USDG domain that matches the on-chain DOMAIN_SEPARATOR', () => {
    // DOMAIN_SEPARATOR() read from USDG on Robinhood Chain testnet.
    const onChain = '0xb1debe91e09d82163fd9cddaab89359061c0671664e1611258a3c3de7c2d950b';
    const domain = { name: 'Global Dollar', version: '1', chainId: 46630n, verifyingContract: USDG } as const;
    expect(
      hashDomain({
        domain,
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
        },
      }),
    ).toBe(onChain);
  });

  it('produces an EIP-3009 authorization that recovers to the session address', async () => {
    const req = await parsePaymentRequired(new Response(JSON.stringify(v1Body), { status: 402 }));
    const r = selectRequirement(req, 46630, USDG, 1_000_000n);
    const signed = await signAuthorization(account, r, 46630, 1_000);
    expect(signed.authorization.validBefore).toBe(1_060n);
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'Global Dollar', version: '1', chainId: 46630, verifyingContract: USDG },
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
      message: signed.authorization,
      signature: signed.signature,
    });
    expect(recovered).toBe(account.address);
  });

  it('builds X-PAYMENT for v1 and PAYMENT-SIGNATURE (with accepted) for v2', async () => {
    const r1 = selectRequirement(await parsePaymentRequired(new Response(JSON.stringify(v1Body))), 46630, USDG, 10n ** 9n);
    const s1 = await signAuthorization(account, r1, 46630);
    const [n1, h1] = paymentHeader(1, r1, s1);
    expect(n1).toBe('X-PAYMENT');
    expect(decode(h1)).toMatchObject({ x402Version: 1, scheme: 'exact', network: 'robinhood-testnet' });
    expect(decode(h1).payload.authorization.value).toBe('10000');

    const header = Buffer.from(JSON.stringify(v2Body)).toString('base64');
    const req2 = await parsePaymentRequired(new Response(null, { status: 402, headers: { 'payment-required': header } }));
    const r2 = selectRequirement(req2, 46630, USDG, 10n ** 9n);
    const [n2, h2] = paymentHeader(2, r2, await signAuthorization(account, r2, 46630));
    expect(n2).toBe('PAYMENT-SIGNATURE');
    expect(decode(h2).accepted).toEqual(v2Body.accepts[0]);
  });
});
