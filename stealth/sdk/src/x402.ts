/**
 * The x402 stealth extension.
 *
 * A merchant opts in per payment option by adding its meta-address, and the settler that will
 * settle the payment, to the requirement's `extra`:
 *
 *   { scheme: "exact", network: "eip155:46630", asset, payTo, amount, ...,
 *     extra: { name, version, stealth: { scheme: "erc5564:1", metaAddress: "st:eth:0x…", settler: "0x…" } } }
 *
 * `payTo` stays the merchant's normal address, so clients that don't know the extension pay as usual.
 * A client that does derives a fresh stealth address and signs an EIP-3009 ReceiveWithAuthorization
 * paying the settler, whose nonce commits to the stealth address and the announcement data. Only the
 * settler can execute it, and only with that data, so the payment is always delivered and announced
 * exactly as signed:
 *
 *   payload: { signature, authorization: { …, to: <settler>, nonce: <commitment> },
 *              stealth: { stealthAddress, ephemeralPublicKey, viewTag } }
 */
import { type Address, type Hex, encodeAbiParameters, getAddress, isAddress, keccak256, toBytes } from 'viem';

import { generateStealthAddress, parseMetaAddress } from './stealth.js';

export const STEALTH_SCHEME = 'erc5564:1';

export interface StealthOffer {
  scheme: typeof STEALTH_SCHEME;
  metaAddress: string;
  /** The SodiStealthSettler that settles and announces the payment. */
  settler: Address;
}

export interface StealthProof {
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  viewTag: Hex;
}

const NONCE_TAG = keccak256(toBytes('sodi-stealth-settle-v1'));

/** The EIP-3009 nonce that commits a payment to its stealth address and announcement (matches the settler). */
export function stealthNonce(p: StealthProof): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes1' }],
      [NONCE_TAG, p.stealthAddress, keccak256(p.ephemeralPublicKey), p.viewTag],
    ),
  );
}

/** Merchant side: adds a stealth offer to a payment requirement. */
export function offerStealth<T extends { extra?: Record<string, unknown> }>(requirement: T, metaAddress: string, settler: Address): T {
  parseMetaAddress(metaAddress); // validate
  const stealth: StealthOffer = { scheme: STEALTH_SCHEME, metaAddress, settler: getAddress(settler) };
  return { ...requirement, extra: { ...(requirement.extra ?? {}), stealth } };
}

/** Client side: the merchant's stealth offer, if it made a valid one. */
export function readStealthOffer(extra: unknown): StealthOffer | undefined {
  const s = (extra as { stealth?: { scheme?: unknown; metaAddress?: unknown; settler?: unknown } } | undefined)?.stealth;
  if (!s || s.scheme !== STEALTH_SCHEME || typeof s.metaAddress !== 'string' || typeof s.settler !== 'string' || !isAddress(s.settler)) {
    return undefined;
  }
  try {
    parseMetaAddress(s.metaAddress);
  } catch {
    return undefined;
  }
  return { scheme: STEALTH_SCHEME, metaAddress: s.metaAddress, settler: getAddress(s.settler) };
}

/**
 * Client side: a one-time stealth address for this payment, and what to sign: a ReceiveWithAuthorization
 * to the settler with the committing nonce.
 */
export function stealthRecipient(offer: StealthOffer): { to: Address; nonce: Hex; proof: StealthProof } {
  const g = generateStealthAddress(offer.metaAddress);
  const proof = { stealthAddress: g.stealthAddress, ephemeralPublicKey: g.ephemeralPublicKey, viewTag: g.viewTag };
  return { to: offer.settler, nonce: stealthNonce(proof), proof };
}
