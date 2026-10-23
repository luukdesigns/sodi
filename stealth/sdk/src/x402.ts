/**
 * The x402 stealth extension.
 *
 * A merchant opts in per payment option by adding its meta-address to the requirement's `extra`:
 *
 *   { scheme: "exact", network: "eip155:46630", asset, payTo, amount, ...,
 *     extra: { name, version, stealth: { scheme: "erc5564:1", metaAddress: "st:eth:0x…" } } }
 *
 * `payTo` stays the merchant's normal address, so clients that don't know the extension pay as usual.
 * A client that does signs its EIP-3009 authorization to a fresh stealth address instead, and adds what
 * the merchant needs to recognise it to the payment payload:
 *
 *   payload: { signature, authorization: { …, to: <stealth address> },
 *              stealth: { ephemeralPublicKey, viewTag } }
 */
import type { Address, Hex } from 'viem';

import { generateStealthAddress, parseMetaAddress } from './stealth.js';

export const STEALTH_SCHEME = 'erc5564:1';

export interface StealthOffer {
  scheme: typeof STEALTH_SCHEME;
  metaAddress: string;
}

export interface StealthProof {
  ephemeralPublicKey: Hex;
  viewTag: Hex;
}

/** Merchant side: adds a stealth offer to a payment requirement. */
export function offerStealth<T extends { extra?: Record<string, unknown> }>(requirement: T, metaAddress: string): T {
  parseMetaAddress(metaAddress); // validate
  const stealth: StealthOffer = { scheme: STEALTH_SCHEME, metaAddress };
  return { ...requirement, extra: { ...(requirement.extra ?? {}), stealth } };
}

/** Client side: the merchant's stealth offer, if it made a valid one. */
export function readStealthOffer(extra: unknown): StealthOffer | undefined {
  const s = (extra as { stealth?: { scheme?: unknown; metaAddress?: unknown } } | undefined)?.stealth;
  if (!s || s.scheme !== STEALTH_SCHEME || typeof s.metaAddress !== 'string') return undefined;
  try {
    parseMetaAddress(s.metaAddress);
  } catch {
    return undefined;
  }
  return { scheme: STEALTH_SCHEME, metaAddress: s.metaAddress };
}

/** Client side: a one-time recipient for this payment, and the proof to attach to the payload. */
export function stealthRecipient(offer: StealthOffer): { to: Address; proof: StealthProof } {
  const g = generateStealthAddress(offer.metaAddress);
  return { to: g.stealthAddress, proof: { ephemeralPublicKey: g.ephemeralPublicKey, viewTag: g.viewTag } };
}
