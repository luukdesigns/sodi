import type { Address, Hex } from 'viem';

/** Which Sodi component an envelope came from; decides how the auditor rebuilds its context. */
export type ItemKind = 'a2a' | 'erc8183-deliverable' | 'erc8183-review' | 'memory';

/**
 * One disclosed envelope. `ref` points at the on-chain log holding it; `contentKey` opens that
 * envelope and nothing else. The auditor fetches the ciphertext from the chain, so the owner cannot
 * substitute different content.
 */
export interface DisclosedItem {
  kind: ItemKind;
  chainId: number;
  contract: Address;
  /** `${txHash}:${logIndex}` */
  ref: string;
  contentKey: Hex;
  /** For memory stored in a blob store. */
  location?: string;
}

/** Everything needed to verify which sessions one rx402 deposit funded. */
export interface PoolDisclosure {
  chainId: number;
  pool: Address;
  entrypoint: Address;
  depositTx: Hex;
  label: string;
  /** Nullifier and secret of the deposit and of each change commitment, in order. */
  chain: { nullifier: string; secret: string }[];
}

export interface Grant {
  v: 1;
  owner: Address;
  issuedAt: number;
  /** Human-readable description of what is being shared and why. */
  note: string;
  items: DisclosedItem[];
  pool?: PoolDisclosure[];
  /** Part n of m when a grant is split across messages. */
  part?: { index: number; total: number; grantId: string };
}

/** Ongoing access to future writes, recorded in the owner's private memory. */
export interface StandingGrant {
  auditor: Address;
  auditorKey: Hex;
  /** e.g. "memory:<slot id>" or "a2a:channel:<id>" */
  scope: string;
  since: number;
  revokedAt?: number;
}
