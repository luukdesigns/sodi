import * as referenceSdk from '@scopelift/stealth-address-sdk';
import { type Hex, hexToBytes, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import {
  StealthMerchant,
  StealthReceiver,
  type X402Payment,
  checkStealthAddress,
  computeStealthKey,
  encodeMetaAddress,
  generateStealthAddress,
  keyDerivationMessage,
  keysFromSignature,
  metaAddressBytes,
  offerStealth,
  parseMetaAddress,
  readStealthOffer,
  stealthRecipient,
  viewingOnly,
} from '../../src/index.js';

const merchantWallet = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const otherWallet = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const payer = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
const keysOf = async (a: typeof merchantWallet) => keysFromSignature(await a.signMessage({ message: keyDerivationMessage(a.address) }));
// The reference SDK's type declarations don't resolve under NodeNext; describe the parts we use.
const reference = referenceSdk as unknown as {
  VALID_SCHEME_ID: { SCHEME_ID_1: number };
  generateStealthAddress(o: { stealthMetaAddressURI: string; schemeId: number; ephemeralPrivateKey?: Uint8Array }): { stealthAddress: Hex; ephemeralPublicKey: Hex; viewTag: Hex };
  computeStealthKey(o: { ephemeralPublicKey: Hex; schemeId: number; spendingPrivateKey: Hex; viewingPrivateKey: Hex }): Hex;
};
const EPH: Hex = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';

describe('ERC-5564 scheme 1', () => {
  it('matches the reference SDK for the stealth address, ephemeral key and view tag', async () => {
    const keys = await keysOf(merchantWallet);
    const meta = encodeMetaAddress(keys);
    const ours = generateStealthAddress(meta, EPH);
    const theirs = reference.generateStealthAddress({ stealthMetaAddressURI: meta, schemeId: reference.VALID_SCHEME_ID.SCHEME_ID_1, ephemeralPrivateKey: hexToBytes(EPH) });
    expect(ours.stealthAddress.toLowerCase()).toBe(theirs.stealthAddress.toLowerCase());
    expect(ours.ephemeralPublicKey).toBe(theirs.ephemeralPublicKey);
    expect(ours.viewTag).toBe(theirs.viewTag);
  });

  it('recognises and spends addresses the reference SDK generates, and the reverse', async () => {
    const keys = await keysOf(merchantWallet);
    const meta = encodeMetaAddress(keys);
    const theirs = reference.generateStealthAddress({ stealthMetaAddressURI: meta, schemeId: reference.VALID_SCHEME_ID.SCHEME_ID_1 });
    expect(checkStealthAddress({ ...theirs, viewingPrivateKey: keys.viewingPrivateKey, spendingPublicKey: keys.spendingPublicKey })).toBe(true);
    const key = computeStealthKey({ ephemeralPublicKey: theirs.ephemeralPublicKey, viewingPrivateKey: keys.viewingPrivateKey, spendingPrivateKey: keys.spendingPrivateKey });
    expect(privateKeyToAccount(key).address).toBe(theirs.stealthAddress);

    const ours = generateStealthAddress(meta);
    const refKey = reference.computeStealthKey({
      ephemeralPublicKey: ours.ephemeralPublicKey,
      schemeId: reference.VALID_SCHEME_ID.SCHEME_ID_1,
      spendingPrivateKey: keys.spendingPrivateKey,
      viewingPrivateKey: keys.viewingPrivateKey,
    });
    expect(privateKeyToAccount(refKey).address).toBe(ours.stealthAddress);
  });

  it('gives every payment a fresh, unrelated address', async () => {
    const meta = encodeMetaAddress(await keysOf(merchantWallet));
    const a = generateStealthAddress(meta);
    const b = generateStealthAddress(meta);
    expect(a.stealthAddress).not.toBe(b.stealthAddress);
    expect(a.ephemeralPublicKey).not.toBe(b.ephemeralPublicKey);
  });

  it("doesn't recognise someone else's payments", async () => {
    const [mine, theirs] = await Promise.all([keysOf(merchantWallet), keysOf(otherWallet)]);
    const g = generateStealthAddress(encodeMetaAddress(theirs));
    expect(checkStealthAddress({ ...g, viewingPrivateKey: mine.viewingPrivateKey, spendingPublicKey: mine.spendingPublicKey })).toBe(false);
    expect(checkStealthAddress({ ...g, viewTag: undefined, viewingPrivateKey: mine.viewingPrivateKey, spendingPublicKey: mine.spendingPublicKey })).toBe(false);
  });
});

describe('meta-addresses and keys', () => {
  it('round-trips the st:eth: form and the 66 registry bytes', async () => {
    const keys = await keysOf(merchantWallet);
    const meta = encodeMetaAddress(keys);
    expect(meta).toMatch(/^st:eth:0x0[23][0-9a-f]{64}0[23][0-9a-f]{64}$/);
    expect(parseMetaAddress(meta)).toEqual({ spendingPublicKey: keys.spendingPublicKey, viewingPublicKey: keys.viewingPublicKey });
    expect(parseMetaAddress(metaAddressBytes(meta))).toEqual(parseMetaAddress(meta));
  });

  it('rejects malformed meta-addresses', () => {
    expect(() => parseMetaAddress('st:eth:0x1234')).toThrow();
    expect(() => parseMetaAddress(`st:eth:0x04${'11'.repeat(32)}02${'11'.repeat(32)}`)).toThrow();
    expect(() => parseMetaAddress(`st:btc:0x02${'11'.repeat(32)}`)).toThrow();
  });

  it('derives the same keys from the same wallet, and separate spending and viewing keys', async () => {
    const [a, b] = await Promise.all([keysOf(merchantWallet), keysOf(merchantWallet)]);
    expect(a).toEqual(b);
    expect(a.spendingPrivateKey).not.toBe(a.viewingPrivateKey);
    expect((await keysOf(otherWallet)).spendingPublicKey).not.toBe(a.spendingPublicKey);
  });

  it('warns that the signature controls funds', () => {
    expect(keyDerivationMessage(merchantWallet.address)).toMatch(/can spend payments/);
  });

  it('can strip the spending key for a watch-only server', async () => {
    const v = viewingOnly(await keysOf(merchantWallet));
    expect(v).not.toHaveProperty('spendingPrivateKey');
  });
});

describe('x402 extension', () => {
  const base = { scheme: 'exact', network: 'eip155:46630', asset: '0x7E955252E15c84f5768B83c41a71F9eba181802F', payTo: merchantWallet.address, amount: '10000', extra: { name: 'Global Dollar', version: '1' } };

  it('adds an offer without touching payTo or the existing extra fields', async () => {
    const meta = encodeMetaAddress(await keysOf(merchantWallet));
    const r = offerStealth(base, meta);
    expect(r.payTo).toBe(base.payTo);
    expect(r.extra).toMatchObject({ name: 'Global Dollar', version: '1', stealth: { scheme: 'erc5564:1', metaAddress: meta } });
    expect(readStealthOffer(r.extra)).toEqual({ scheme: 'erc5564:1', metaAddress: meta });
  });

  it('ignores missing or malformed offers', () => {
    expect(readStealthOffer(base.extra)).toBeUndefined();
    expect(readStealthOffer({ stealth: { scheme: 'erc5564:1', metaAddress: 'st:eth:0xdead' } })).toBeUndefined();
    expect(readStealthOffer({ stealth: { scheme: 'other', metaAddress: 'x' } })).toBeUndefined();
  });
});

describe('verifying a stealth payment', async () => {
  const keys = await keysOf(merchantWallet);
  const receiver = new StealthReceiver(viewingOnly(keys));
  const asset = '0x7E955252E15c84f5768B83c41a71F9eba181802F' as const;
  const domain = { name: 'Global Dollar', version: '1' };
  const now = 1_800_000_000;
  const expected = { asset, amount: 10_000n, chainId: 46630, domain };

  async function pay(opts: { metaAddress?: string; value?: bigint; validBefore?: bigint; signer?: typeof payer } = {}): Promise<X402Payment> {
    const { to, proof } = stealthRecipient({ scheme: 'erc5564:1', metaAddress: opts.metaAddress ?? receiver.metaAddress });
    const authorization = { from: payer.address, to, value: opts.value ?? 10_000n, validAfter: 0n, validBefore: opts.validBefore ?? BigInt(now + 300), nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) };
    const signature = await (opts.signer ?? payer).signTypedData({
      domain: { ...domain, chainId: 46630, verifyingContract: asset },
      types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
      primaryType: 'TransferWithAuthorization',
      message: authorization,
    });
    const s = (x: bigint) => x.toString();
    return {
      x402Version: 2,
      payload: {
        signature,
        authorization: { ...authorization, value: s(authorization.value), validAfter: s(authorization.validAfter), validBefore: s(authorization.validBefore) },
        stealth: proof,
      },
    };
  }

  it('accepts a valid payment to one of our stealth addresses', async () => {
    const p = await pay();
    const v = await receiver.verify(p, expected, now);
    expect(v.stealthAddress).toBe(p.payload.authorization.to);
    expect(v.from).toBe(payer.address);
  });

  it('lets the full merchant spend what the watch-only receiver accepted', async () => {
    const p = await pay();
    const key = new StealthMerchant(keys).keyFor(p.payload.stealth!.ephemeralPublicKey);
    expect(privateKeyToAccount(key).address).toBe(p.payload.authorization.to);
  });

  it("rejects payments to another merchant's stealth address", async () => {
    const other = encodeMetaAddress(await keysOf(otherWallet));
    await expect(receiver.verify(await pay({ metaAddress: other }), expected, now)).rejects.toThrow(/not one of our stealth addresses/);
  });

  it('rejects underpayment, expiry, a forged signature and a missing proof', async () => {
    await expect(receiver.verify(await pay({ value: 9_999n }), expected, now)).rejects.toThrow(/underpaid/);
    await expect(receiver.verify(await pay({ validBefore: BigInt(now) }), expected, now)).rejects.toThrow(/expires/);
    await expect(receiver.verify(await pay({ signer: otherWallet }), expected, now)).rejects.toThrow(/signature/);
    const p = await pay();
    delete p.payload.stealth;
    await expect(receiver.verify(p, expected, now)).rejects.toThrow(/not a stealth payment/);
  });
});
