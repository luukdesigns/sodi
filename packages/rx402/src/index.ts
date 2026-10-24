export {
  Rx402Client,
  type IssuedRx402Config,
  type LocalRx402Config,
  type PaidResponse,
  type FetchOptions,
  type RecycleOutcome,
  type Rx402Config,
  type SessionPolicy,
  type SessionSource,
} from './client.js';
export { PoolWallet, type Funding, type PoolWalletConfig } from './wallet.js';
export { poolFromDeployment, type SodiDeployment } from './deployment.js';
export {
  type RecycleRequest,
  type RecycleSubmitter,
  type TokenDomain,
  USDG_DOMAIN,
  WalletRecycleSubmitter,
  recycleArgs,
  recycleFrom,
  recycleMinimum,
  recycleNonce,
  recyclerAbi,
  signRecycle,
} from './recycle.js';
export {
  IssuerSessions,
  type IssuerError,
  type IssuerFunding,
  type IssuerRefusal,
  type IssuerRequest,
  type IssuerSessionsConfig,
  type IssuerStatus,
  type SignedIssuerRequest,
  issuerMessage,
  parseIssuerRequest,
} from './issuer.js';
export { WalletRelayer, type Relayer } from './relayer.js';
export {
  RagequitProver,
  WithdrawalProver,
  defaultArtifactPaths,
  defaultCommitmentArtifactPaths,
  type ArtifactPaths,
  type RagequitSolidityProof,
  type SolidityProof,
} from './prover.js';
export { FileStore, MemoryStore, type Grant, type PaymentRecord, type PoolNote, type Session, type Store, type WalletState } from './store.js';
export {
  type BlockReason,
  type ControlSource,
  type Controls,
  FileControls,
  MemoryControls,
  PaymentBlockedError,
  defaultControls,
} from './controls.js';
export * from './x402.js';
export * from './crypto.js';
export { depositedEvent, entrypointAbi, erc20Abi, funderAbi, poolAbi, vaultAbi } from './chain.js';
export { HttpRelayer, type RelayQuote } from './http-relayer.js';

/** Fetches approved labels from a Sodi approval service (`GET /association-set`). */
export function aspAssociationSet(baseUrl: string): () => Promise<bigint[]> {
  return async () => {
    const res = await fetch(new URL('/association-set', baseUrl));
    if (!res.ok) throw new Error(`approval service returned ${res.status}`);
    const body = (await res.json()) as { labels: string[] };
    return body.labels.map(BigInt);
  };
}
