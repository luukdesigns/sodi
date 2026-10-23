import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { DepositRecord } from './screening.js';

export interface PublishedSet {
  root: string;
  cid: string;
  labelCount: number;
  /** The updateRoot transaction; absent when the root was already on-chain (adopted on restart). */
  txHash?: string;
  publishedAt: number;
}

export interface ServiceState {
  chainId: number;
  entrypoint: string;
  lastScannedBlock: number;
  deposits: DepositRecord[];
  published: PublishedSet[];
}

export function loadState(path: string, fresh: () => ServiceState): ServiceState {
  if (!existsSync(path)) return fresh();
  return JSON.parse(readFileSync(path, 'utf8')) as ServiceState;
}

/** Atomic write so a crash mid-save never leaves a corrupt state file. */
export function saveState(path: string, state: ServiceState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}
