import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Address, Hex } from 'viem';

/**
 * A deposit in the pool and how much of it is left. Secrets are not stored: they are re-derived
 * from the mnemonic using (scope, depositIndex) and (label, spendCount).
 */
export interface PoolNote {
  scope: string;
  depositIndex: number;
  label: string;
  /** Value of the current (unspent) commitment. */
  value: string;
  /** Withdrawals made from this deposit so far. */
  spendCount: number;
  depositTx: Hex;
}

/** A fresh address funded from the pool, used to pay x402 merchants. */
export interface Session {
  address: Address;
  /**
   * Private key of the session address. It only ever holds the session budget, but treat the
   * store file as sensitive.
   */
  privateKey: Hex;
  budget: string;
  spent: string;
  payments: number;
  openedAt: number;
  fundingTx: Hex;
}

export interface WalletState {
  version: 1;
  notes: PoolNote[];
  /** Deposits made per scope, so the next deposit uses fresh secrets. */
  depositCounts: Record<string, number>;
  sessions: Session[];
}

export interface Store {
  load(): WalletState;
  save(state: WalletState): void;
}

const empty = (): WalletState => ({ version: 1, notes: [], depositCounts: {}, sessions: [] });

export class MemoryStore implements Store {
  private state = empty();
  load() {
    return structuredClone(this.state);
  }
  save(state: WalletState) {
    this.state = structuredClone(state);
  }
}

/** JSON file, written atomically. Created with owner-only permissions. */
export class FileStore implements Store {
  constructor(private readonly path: string) {}

  load(): WalletState {
    if (!existsSync(this.path)) return empty();
    return JSON.parse(readFileSync(this.path, 'utf8')) as WalletState;
  }

  save(state: WalletState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
