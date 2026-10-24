/**
 * Stealth keys derived from a wallet signature, so a merchant can recover them from its wallet alone.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { mod } from '@noble/curves/abstract/modular';
import { type Address, type Hex, type WalletClient, bytesToHex, getAddress, hexToBytes } from 'viem';

import { type MetaAddressKeys, encodeMetaAddress } from './stealth.js';

export interface ViewingKeys extends MetaAddressKeys {
  viewingPrivateKey: Hex;
}

export interface StealthKeys extends ViewingKeys {
  spendingPrivateKey: Hex;
}

export function keyDerivationMessage(address: Address): string {
  return [
    'Sodi stealth keys',
    '',
    `Sign to derive the stealth payment keys for ${getAddress(address)}.`,
    'Anyone with this signature can spend payments sent to your stealth addresses, so only sign it in software you trust.',
    '',
    'This does not authorize any transaction.',
  ].join('\n');
}

function scalar(ikm: Uint8Array, info: string): Hex {
  // 48 bytes reduced mod n-1, plus one: uniform and never zero (as in RFC 9380 hash_to_field).
  const okm = hkdf(sha256, ikm, 'sodi-stealth-v1', info, 48);
  const k = mod(BigInt(bytesToHex(okm)), secp256k1.CURVE.n - 1n) + 1n;
  return `0x${k.toString(16).padStart(64, '0')}`;
}

const N = secp256k1.CURVE.n;

/** One encoding per signature (low s, v = 27/28), so the same wallet always gets the same keys. */
export function canonicalSignature(signature: Hex): Hex {
  const b = hexToBytes(signature);
  if (b.length !== 65) throw new Error('expected a 65-byte signature');
  let s = BigInt(bytesToHex(b.slice(32, 64)));
  let yParity = b[64]! >= 27 ? b[64]! - 27 : b[64]!;
  if (yParity > 1) throw new Error('invalid signature recovery byte');
  if (s > N / 2n) {
    s = N - s;
    yParity ^= 1;
  }
  const out = new Uint8Array(65);
  out.set(b.slice(0, 32));
  out.set(hexToBytes(`0x${s.toString(16).padStart(64, '0')}`), 32);
  out[64] = 27 + yParity;
  return bytesToHex(out);
}

/** Derives spending and viewing keys from a signature over `keyDerivationMessage`. */
export function keysFromSignature(signature: Hex): StealthKeys {
  const ikm = hexToBytes(canonicalSignature(signature));
  const spendingPrivateKey = scalar(ikm, 'spending');
  const viewingPrivateKey = scalar(ikm, 'viewing');
  return {
    spendingPrivateKey,
    viewingPrivateKey,
    spendingPublicKey: bytesToHex(secp256k1.getPublicKey(hexToBytes(spendingPrivateKey), true)),
    viewingPublicKey: bytesToHex(secp256k1.getPublicKey(hexToBytes(viewingPrivateKey), true)),
  };
}

/** Asks the wallet to sign the derivation message and returns the keys. */
export async function deriveStealthKeys(wallet: WalletClient): Promise<StealthKeys> {
  const account = wallet.account;
  if (!account) throw new Error('wallet has no account');
  const message = keyDerivationMessage(account.address);
  // A wallet that signs non-deterministically (some MPC and HSM signers) would give a different
  // meta-address every time, and payments to the published one could never be spent.
  const [a, b] = await Promise.all([wallet.signMessage({ account, message }), wallet.signMessage({ account, message })]);
  if (canonicalSignature(a) !== canonicalSignature(b)) {
    throw new Error('this wallet produces non-deterministic signatures; it cannot derive stable stealth keys');
  }
  return keysFromSignature(a);
}

/** The view-only half: can recognise payments, can't spend them. Safe to give a merchant server. */
export function viewingOnly(keys: StealthKeys | ViewingKeys): ViewingKeys {
  const { viewingPrivateKey, spendingPublicKey, viewingPublicKey } = keys;
  return { viewingPrivateKey, spendingPublicKey, viewingPublicKey };
}

export const metaAddressOf = (keys: MetaAddressKeys) => encodeMetaAddress(keys);
