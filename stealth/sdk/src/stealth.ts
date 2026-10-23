/**
 * ERC-5564 scheme 1: stealth addresses on secp256k1 with view tags.
 *
 * A recipient publishes a meta-address: a spending public key and a viewing public key. A payer picks a
 * random ephemeral key and derives a one-time address only the recipient can spend from:
 *
 *   s   = compressed(ephemeralPrivate · viewingPublic)     shared secret
 *   s_h = keccak256(s)                                      hashed shared secret
 *   P   = spendingPublic + s_h · G                          stealth public key
 *   key = spendingPrivate + s_h  (mod n)                    stealth private key, recipient only
 *
 * The view tag is the first byte of s_h; it lets a scanner skip ~255/256 announcements with one
 * multiplication. Matches the ERC-5564 reference SDK (cross-checked in the tests).
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { type Address, type Hex, bytesToHex, hexToBytes, keccak256 } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';

export const SCHEME_ID = 1n;
const N = secp256k1.CURVE.n;
const G = secp256k1.ProjectivePoint.BASE;

export interface MetaAddressKeys {
  /** 33-byte compressed public keys. */
  spendingPublicKey: Hex;
  viewingPublicKey: Hex;
}

export interface GeneratedStealthAddress {
  stealthAddress: Address;
  /** 33-byte compressed ephemeral public key, published in the announcement. */
  ephemeralPublicKey: Hex;
  /** One byte, as 0x-prefixed hex. */
  viewTag: Hex;
}

const isCompressedKey = (k: string) => /^0[23][0-9a-fA-F]{64}$/.test(k);

/** `st:eth:0x<spending><viewing>` for a pair of public keys. */
export function encodeMetaAddress(keys: MetaAddressKeys): string {
  return `st:eth:${keys.spendingPublicKey}${keys.viewingPublicKey.slice(2)}`;
}

/** The 66 raw bytes stored in the ERC-6538 registry. */
export function metaAddressBytes(metaAddress: string): Hex {
  const k = parseMetaAddress(metaAddress);
  return `${k.spendingPublicKey}${k.viewingPublicKey.slice(2)}`;
}

/** Parses `st:eth:0x…` or raw 0x-hex (66 bytes, or 33 when one key serves both roles). */
export function parseMetaAddress(metaAddress: string): MetaAddressKeys {
  let hex = metaAddress;
  if (metaAddress.startsWith('st:')) {
    const parts = metaAddress.split(':');
    if (parts.length !== 3 || parts[1] !== 'eth') throw new Error('not an Ethereum stealth meta-address');
    hex = parts[2]!;
  }
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  const spending = body.slice(0, 66);
  const viewing = body.length === 132 ? body.slice(66) : body.length === 66 ? spending : '';
  if (!isCompressedKey(spending) || !isCompressedKey(viewing)) throw new Error('malformed stealth meta-address');
  // Throws if either is not a point on the curve.
  secp256k1.ProjectivePoint.fromHex(spending);
  secp256k1.ProjectivePoint.fromHex(viewing);
  return { spendingPublicKey: `0x${spending.toLowerCase()}`, viewingPublicKey: `0x${viewing.toLowerCase()}` };
}

function hashedSharedSecret(privateKey: Hex, publicKey: Hex): bigint {
  const shared = secp256k1.getSharedSecret(hexToBytes(privateKey), hexToBytes(publicKey), true);
  return BigInt(keccak256(shared));
}

const viewTagOf = (h: bigint): Hex => `0x${h.toString(16).padStart(64, '0').slice(0, 2)}`;

function stealthAddressFrom(spendingPublicKey: Hex, h: bigint): Address {
  const p = secp256k1.ProjectivePoint.fromHex(spendingPublicKey.slice(2)).add(G.multiply(h % N));
  return publicKeyToAddress(bytesToHex(p.toRawBytes(false)));
}

/** Payer side: a fresh one-time address for the owner of `metaAddress`. */
export function generateStealthAddress(metaAddress: string, ephemeralPrivateKey?: Hex): GeneratedStealthAddress {
  const { spendingPublicKey, viewingPublicKey } = parseMetaAddress(metaAddress);
  const eph = ephemeralPrivateKey ?? bytesToHex(secp256k1.utils.randomPrivateKey());
  const h = hashedSharedSecret(eph, viewingPublicKey);
  return {
    stealthAddress: stealthAddressFrom(spendingPublicKey, h),
    ephemeralPublicKey: bytesToHex(secp256k1.getPublicKey(hexToBytes(eph), true)),
    viewTag: viewTagOf(h),
  };
}

/**
 * Recipient side, with the viewing key only: is this announcement ours? Returns false fast when the
 * view tag doesn't match. Needs no spending key, so a watch-only server can run it.
 */
export function checkStealthAddress(opts: {
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  viewTag?: Hex;
  viewingPrivateKey: Hex;
  spendingPublicKey: Hex;
}): boolean {
  let h: bigint;
  try {
    h = hashedSharedSecret(opts.viewingPrivateKey, opts.ephemeralPublicKey);
  } catch {
    return false; // not a valid point
  }
  if (opts.viewTag !== undefined && viewTagOf(h) !== opts.viewTag.toLowerCase()) return false;
  return stealthAddressFrom(opts.spendingPublicKey, h).toLowerCase() === opts.stealthAddress.toLowerCase();
}

/** Recipient side, with both keys: the private key that controls a stealth address. */
export function computeStealthKey(opts: { ephemeralPublicKey: Hex; viewingPrivateKey: Hex; spendingPrivateKey: Hex }): Hex {
  const h = hashedSharedSecret(opts.viewingPrivateKey, opts.ephemeralPublicKey);
  const k = (BigInt(opts.spendingPrivateKey) + h) % N;
  return `0x${k.toString(16).padStart(64, '0')}`;
}
