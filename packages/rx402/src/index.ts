export { Rx402Client, type PaidResponse, type Rx402Config, type SessionPolicy } from './client.js';
export { WalletRelayer, type Relayer } from './relayer.js';
export { WithdrawalProver, defaultArtifactPaths, type ArtifactPaths } from './prover.js';
export { FileStore, MemoryStore, type PoolNote, type Session, type Store, type WalletState } from './store.js';
export * from './x402.js';
export * from './crypto.js';

/** Fetches approved labels from a Sodi approval service (`GET /association-set`). */
export function aspAssociationSet(baseUrl: string): () => Promise<bigint[]> {
  return async () => {
    const res = await fetch(new URL('/association-set', baseUrl));
    if (!res.ok) throw new Error(`approval service returned ${res.status}`);
    const body = (await res.json()) as { labels: string[] };
    return body.labels.map(BigInt);
  };
}
