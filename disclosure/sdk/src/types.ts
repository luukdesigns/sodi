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

/**
 * Contracts an auditor accepts disclosures from. An owner could otherwise point the auditor at a
 * contract of their own that emits whatever "messages" they like, attributed to anyone.
 */
export interface TrustedContracts {
  a2a: Address[];
  memory: Address[];
  erc8183Hooks: Address[];
  pools: { pool: Address; entrypoint: Address }[];
}

/** The Sodi deployments, by chain. Pass your own list to the Auditor to override. */
export const SODI_DEPLOYMENTS: Record<number, TrustedContracts> = {
  46630: {
    a2a: ['0xcc20a2E48943BAE122Cb9DCD92ca5ceb190E9d62'],
    memory: ['0x5792659446E32eF320Dd19b42cc27a3737ac710e'],
    erc8183Hooks: ['0x31eed88eb741f0e964f5726a7d1900f712c8eab5'],
    pools: [{ pool: '0x8cddbb1C33ce49aB72FD1765649835935604BF76', entrypoint: '0xaCa6B50b648a6f575a009DC7c97aBe62808869Ce' }],
  },
};
