import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { bytesToHex, hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import {
  type Context,
  associatedData,
  canonicalSignature,
  isValidRecipientKey,
  keyDerivationMessage,
  keyPairFromSignature,
  open,
  openWithContentKey,
  pad,
  seal,
  unpad,
  unwrapContentKey,
} from '../../src/crypto.js';

const alice = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const bob = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const eve = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');

const keysOf = async (a: typeof alice) => keyPairFromSignature(await a.signMessage({ message: keyDerivationMessage(a.address) }));
const ctx: Context = {
  chainId: 46630,
  contract: '0x00000000000000000000000000000000000000A2',
  channelId: 7n,
  author: alice.address,
};
const msg = new TextEncoder().encode('bid: 0.42 USDG per GPU-hour');

describe('key derivation', () => {
  it('gives the same key from the same wallet every time', async () => {
    expect((await keysOf(alice)).publicKey).toBe((await keysOf(alice)).publicKey);
  });

  it('gives different wallets different keys', async () => {
    expect((await keysOf(alice)).publicKey).not.toBe((await keysOf(bob)).publicKey);
  });

  it('binds the signed message to the address', () => {
    expect(keyDerivationMessage(alice.address)).toContain(alice.address);
    expect(keyDerivationMessage(alice.address)).toMatch(/does not authorize any transaction/);
  });
});

describe('envelopes', () => {
  it('opens for every recipient and nobody else', async () => {
    const [a, b, e] = await Promise.all([keysOf(alice), keysOf(bob), keysOf(eve)]);
    const env = seal(msg, [a.publicKey, b.publicKey], ctx);
    expect(open(env, a, ctx)).toEqual(msg);
    expect(open(env, b, ctx)).toEqual(msg);
    expect(open(env, e, ctx)).toBeNull();
  });

  it('does not contain recipient keys or the plaintext', async () => {
    const [a, b] = await Promise.all([keysOf(alice), keysOf(bob)]);
    const hex = bytesToHex(seal(msg, [a.publicKey, b.publicKey], ctx));
    expect(hex).not.toContain(a.publicKey.slice(2));
    expect(hex).not.toContain(b.publicKey.slice(2));
    expect(hex).not.toContain(bytesToHex(msg).slice(2));
  });

  it('is bound to its chain, contract, channel and author', async () => {
    const b = await keysOf(bob);
    const env = seal(msg, [b.publicKey], ctx);
    expect(open(env, b, { ...ctx, author: eve.address })).toBeNull();
    expect(open(env, b, { ...ctx, channelId: 8n })).toBeNull();
    expect(open(env, b, { ...ctx, chainId: 4663 })).toBeNull();
    expect(open(env, b, { ...ctx, contract: '0x00000000000000000000000000000000000000A3' })).toBeNull();
  });

  it('rejects tampering', async () => {
    const b = await keysOf(bob);
    const env = seal(msg, [b.publicKey], ctx);
    const flipped = env.slice();
    flipped[flipped.length - 20]! ^= 1;
    expect(open(flipped, b, ctx)).toBeNull();
  });

  it('pads messages so short ones all look the same size', async () => {
    const b = await keysOf(bob);
    const short = seal(new TextEncoder().encode('yes'), [b.publicKey], ctx);
    const longer = seal(new TextEncoder().encode('x'.repeat(200)), [b.publicKey], ctx);
    expect(short.length).toBe(longer.length);
  });

  it('uses a fresh ephemeral key and nonce every time', async () => {
    const b = await keysOf(bob);
    expect(bytesToHex(seal(msg, [b.publicKey], ctx))).not.toBe(bytesToHex(seal(msg, [b.publicKey], ctx)));
  });

  it('ignores junk and foreign data without throwing', async () => {
    const b = await keysOf(bob);
    expect(open(new Uint8Array(10), b, ctx)).toBeNull();
    expect(open(hexToBytes(`0xa201${'00'.repeat(200)}`), b, ctx)).toBeNull();
  });

  it('round-trips padding', () => {
    expect(unpad(pad(msg))).toEqual(msg);
    expect(() => pad(new Uint8Array(2_000_000))).toThrow(/too large/);
  });
});

describe('content keys (used for disclosure)', () => {
  it('open exactly one envelope and nothing else', async () => {
    const b = await keysOf(bob);
    const one = seal(msg, [b.publicKey], ctx);
    const two = seal(new TextEncoder().encode('another message'), [b.publicKey], ctx);
    const k1 = unwrapContentKey(one, b, ctx)!;
    expect(openWithContentKey(one, k1, ctx)).toEqual(msg);
    expect(openWithContentKey(two, k1, ctx)).toBeNull();
  });

  it('cannot be recovered by non-recipients', async () => {
    const [b, e] = await Promise.all([keysOf(bob), keysOf(eve)]);
    expect(unwrapContentKey(seal(msg, [b.publicKey], ctx), e, ctx)).toBeNull();
  });

  it('still respect the context', async () => {
    const b = await keysOf(bob);
    const env = seal(msg, [b.publicKey], ctx);
    const k = unwrapContentKey(env, b, ctx)!;
    expect(openWithContentKey(env, k, { ...ctx, author: eve.address })).toBeNull();
  });
});

describe('commitment and padding (review fixes)', () => {
  /** Re-encrypts an envelope's body under its own content key after `edit`, as a malicious author could. */
  async function tampered(edit: (body: Uint8Array) => void) {
    const b = await keysOf(bob);
    const env = seal(msg, [b.publicKey], ctx);
    const k = unwrapContentKey(env, b, ctx)!;
    const slotsEnd = 36 + 48;
    const nonce = env.slice(slotsEnd, slotsEnd + 24);
    const padded = xchacha20poly1305(k, nonce, associatedData(ctx)).decrypt(env.slice(slotsEnd + 24));
    edit(padded);
    const ct = xchacha20poly1305(k, nonce, associatedData(ctx)).encrypt(padded);
    const out = new Uint8Array(slotsEnd + 24 + ct.length);
    out.set(env.slice(0, slotsEnd + 24));
    out.set(ct, slotsEnd + 24);
    return { out, k };
  }

  it('rejects a body whose key commitment does not match its key', async () => {
    const { out, k } = await tampered((p) => p.fill(0, 4, 36));
    expect(openWithContentKey(out, k, ctx)).toBeNull();
  });

  it('rejects non-zero padding, which would give a forger free bytes', async () => {
    const { out, k } = await tampered((p) => (p[p.length - 1] = 7));
    expect(openWithContentKey(out, k, ctx)).toBeNull();
  });

  it('derives the same key whatever encoding the wallet uses for the signature', async () => {
    const sig = await bob.signMessage({ message: keyDerivationMessage(bob.address) });
    const b = hexToBytes(sig);
    const v01 = b.slice();
    v01[64] = b[64]! - 27;
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = b.slice();
    highS.set(hexToBytes(`0x${(n - BigInt(bytesToHex(b.slice(32, 64)))).toString(16).padStart(64, '0')}`), 32);
    highS[64] = b[64] === 27 ? 28 : 27;
    for (const variant of [v01, highS]) {
      expect(canonicalSignature(bytesToHex(variant))).toBe(sig);
      expect(keyPairFromSignature(bytesToHex(variant)).publicKey).toBe(keyPairFromSignature(sig).publicKey);
    }
  });

  it('refuses low-order recipient keys with a clear error', async () => {
    const zeroish = `0x01${'00'.repeat(31)}` as const;
    expect(isValidRecipientKey(zeroish)).toBe(false);
    expect(isValidRecipientKey((await keysOf(bob)).publicKey)).toBe(true);
    expect(() => seal(msg, [zeroish], ctx)).toThrow(/not a valid X25519 public key/);
  });
});
