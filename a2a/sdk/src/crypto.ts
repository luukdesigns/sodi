import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { type Address, type Hex, bytesToHex, getAddress, hexToBytes } from 'viem';

/**
 * Sodi A2A envelope, protocol version 1.
 *
 *   0xA2 | 0x01 | ephemeralPub(32) | count(u16) | count × wrappedKey(48) | nonce(24) | ciphertext+tag
 *
 * One random content key encrypts the (padded) message once with XChaCha20-Poly1305. The content key
 * is then wrapped for every recipient under a key derived from X25519(ephemeral, recipient). Wrapped
 * keys carry no recipient identifiers and are shuffled, so the envelope does not reveal who it is for:
 * each reader tries to unwrap every slot and only real recipients succeed.
 *
 * Every AEAD call authenticates the context (chain, contract, channel, author), so an envelope copied
 * to another channel, contract or author fails to decrypt.
 */

export const ENVELOPE_MAGIC = 0xa2;
export const ENVELOPE_VERSION = 0x01;
const WRAPPED = 48; // 32-byte key + 16-byte tag
const NONCE = 24;
const PAD_BUCKETS = [256, 1024, 4096, 12_288];
const enc = new TextEncoder();

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Hex;
}

/**
 * The message an agent signs to derive its messaging key. Same wallet, same signature, same key:
 * nothing needs to be stored, and the key can be recovered on any device.
 */
export function keyDerivationMessage(address: Address): string {
  return [
    'Sodi A2A encryption key',
    '',
    'Signing this creates your private messaging key. It does not authorize any transaction or payment.',
    '',
    `Address: ${getAddress(address)}`,
    'Version: 1',
  ].join('\n');
}

export function keyPairFromSignature(signature: Hex): KeyPair {
  const seed = hkdf(sha256, hexToBytes(signature), enc.encode('sodi-a2a-v1'), enc.encode('x25519 messaging key'), 32);
  return { privateKey: seed, publicKey: bytesToHex(x25519.getPublicKey(seed)) };
}

export interface Context {
  chainId: number;
  contract: Address;
  channelId: bigint;
  author: Address;
}

export function associatedData(c: Context): Uint8Array {
  const out = new Uint8Array(11 + 8 + 20 + 32 + 20);
  out.set(enc.encode('sodi-a2a-v1'), 0);
  new DataView(out.buffer).setBigUint64(11, BigInt(c.chainId));
  out.set(hexToBytes(getAddress(c.contract)), 19);
  out.set(hexToBytes(`0x${c.channelId.toString(16).padStart(64, '0')}`), 39);
  out.set(hexToBytes(getAddress(c.author)), 71);
  return out;
}

/** Length-prefixed and zero-padded to a size bucket, so ciphertext length leaks little. */
export function pad(message: Uint8Array): Uint8Array {
  const needed = message.length + 4;
  const bucket = PAD_BUCKETS.find((b) => b >= needed);
  if (!bucket) throw new Error(`message too large (${message.length} bytes)`);
  const out = new Uint8Array(bucket);
  new DataView(out.buffer).setUint32(0, message.length);
  out.set(message, 4);
  return out;
}

export function unpad(padded: Uint8Array): Uint8Array {
  const len = new DataView(padded.buffer, padded.byteOffset).getUint32(0);
  if (len > padded.length - 4) throw new Error('invalid padding');
  return padded.slice(4, 4 + len);
}

function wrapKey(shared: Uint8Array, ephemeralPub: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  const salt = new Uint8Array(64);
  salt.set(ephemeralPub, 0);
  salt.set(recipientPub, 32);
  return hkdf(sha256, shared, salt, enc.encode('sodi-a2a-v1 wrap'), 32);
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = new DataView(randomBytes(4).buffer).getUint32(0) % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function seal(message: Uint8Array, recipients: Hex[], context: Context): Uint8Array {
  const unique = [...new Set(recipients.map((r) => r.toLowerCase() as Hex))];
  if (unique.length === 0) throw new Error('at least one recipient is required');
  if (unique.length > 0xffff) throw new Error('too many recipients');
  const aad = associatedData(context);
  const contentKey = randomBytes(32);
  const ephemeral = randomBytes(32);
  const ephemeralPub = x25519.getPublicKey(ephemeral);

  // Each recipient's wrapping key is unique, so a fixed zero nonce is safe for the wrap.
  const zeroNonce = new Uint8Array(NONCE);
  const wrapped = shuffle(
    unique.map((r) => {
      const rPub = hexToBytes(r);
      const kek = wrapKey(x25519.getSharedSecret(ephemeral, rPub), ephemeralPub, rPub);
      return xchacha20poly1305(kek, zeroNonce, aad).encrypt(contentKey);
    }),
  );

  const nonce = randomBytes(NONCE);
  const ciphertext = xchacha20poly1305(contentKey, nonce, aad).encrypt(pad(message));

  const out = new Uint8Array(2 + 32 + 2 + wrapped.length * WRAPPED + NONCE + ciphertext.length);
  let o = 0;
  out[o++] = ENVELOPE_MAGIC;
  out[o++] = ENVELOPE_VERSION;
  out.set(ephemeralPub, o);
  o += 32;
  new DataView(out.buffer).setUint16(o, wrapped.length);
  o += 2;
  for (const w of wrapped) {
    out.set(w, o);
    o += WRAPPED;
  }
  out.set(nonce, o);
  o += NONCE;
  out.set(ciphertext, o);
  return out;
}

interface Parsed {
  ephemeralPub: Uint8Array;
  count: number;
  slotsEnd: number;
}

function parse(envelope: Uint8Array): Parsed | null {
  if (envelope.length < 2 + 32 + 2 + WRAPPED + NONCE + 16) return null;
  if (envelope[0] !== ENVELOPE_MAGIC || envelope[1] !== ENVELOPE_VERSION) return null;
  const count = new DataView(envelope.buffer, envelope.byteOffset).getUint16(34);
  const slotsEnd = 36 + count * WRAPPED;
  if (envelope.length < slotsEnd + NONCE + 16) return null;
  return { ephemeralPub: envelope.slice(2, 34), count, slotsEnd };
}

/**
 * Recovers the envelope's content key if `keys` is a recipient. The content key decrypts this one
 * envelope and nothing else, which is what makes per-item disclosure possible: handing it to an
 * auditor reveals exactly this message.
 */
export function unwrapContentKey(envelope: Uint8Array, keys: KeyPair, context: Context): Uint8Array | null {
  const p = parse(envelope);
  if (!p) return null;
  const aad = associatedData(context);
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(keys.privateKey, p.ephemeralPub);
  } catch {
    return null;
  }
  const kek = wrapKey(shared, p.ephemeralPub, hexToBytes(keys.publicKey));
  const zeroNonce = new Uint8Array(NONCE);
  for (let i = 0; i < p.count; i++) {
    const slot = envelope.slice(36 + i * WRAPPED, 36 + (i + 1) * WRAPPED);
    try {
      const contentKey = xchacha20poly1305(kek, zeroNonce, aad).decrypt(slot);
      // Only return keys that actually open the body under this context.
      return openWithContentKey(envelope, contentKey, context) ? contentKey : null;
    } catch {
      // someone else's slot
    }
  }
  return null;
}

/** Decrypts an envelope given its content key, e.g. one received in a disclosure. */
export function openWithContentKey(envelope: Uint8Array, contentKey: Uint8Array, context: Context): Uint8Array | null {
  const p = parse(envelope);
  if (!p) return null;
  try {
    const nonce = envelope.slice(p.slotsEnd, p.slotsEnd + NONCE);
    const padded = xchacha20poly1305(contentKey, nonce, associatedData(context)).decrypt(envelope.slice(p.slotsEnd + NONCE));
    return unpad(padded);
  } catch {
    return null;
  }
}

/** Returns the message if `keys` is a recipient, otherwise null. Never throws on foreign envelopes. */
export function open(envelope: Uint8Array, keys: KeyPair, context: Context): Uint8Array | null {
  const contentKey = unwrapContentKey(envelope, keys, context);
  return contentKey ? openWithContentKey(envelope, contentKey, context) : null;
}
