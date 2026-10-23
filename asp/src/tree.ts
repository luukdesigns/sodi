import { LeanIMT } from '@zk-kit/lean-imt';
import { poseidon } from 'maci-crypto/build/ts/hashing.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';

/**
 * The association set is a LeanIMT of approved deposit labels hashed with Poseidon(2).
 * This matches the withdrawal circuit's `LeanIMTInclusionProof` and the hashing used by
 * the 0xbow Privacy Pools SDK (same library versions).
 */
export function buildTree(labels: readonly bigint[]): LeanIMT<bigint> {
  const tree = new LeanIMT<bigint>((a, b) => poseidon([a, b]));
  if (labels.length > 0) tree.insertMany([...labels]);
  return tree;
}

export function computeRoot(labels: readonly bigint[]): bigint {
  return labels.length === 0 ? 0n : buildTree(labels).root;
}

/** Published association-set document. Its CID is what goes on-chain next to the root. */
export interface AssociationSetDocument {
  version: 1;
  chainId: number;
  entrypoint: string;
  root: string;
  labels: string[];
}

export function associationSetDocument(
  chainId: number,
  entrypoint: string,
  labels: readonly bigint[],
): AssociationSetDocument {
  return {
    version: 1,
    chainId,
    entrypoint: entrypoint.toLowerCase(),
    root: computeRoot(labels).toString(),
    labels: labels.map((l) => l.toString()),
  };
}

/** Canonical bytes: keys in a fixed order, no whitespace. */
export function encodeDocument(doc: AssociationSetDocument): Uint8Array {
  const ordered = {
    version: doc.version,
    chainId: doc.chainId,
    entrypoint: doc.entrypoint,
    root: doc.root,
    labels: doc.labels,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/**
 * IPFS CIDv1 (raw codec, sha2-256) of the document, e.g. "bafkrei…" (59 chars).
 * The Entrypoint requires a CID between 32 and 64 characters.
 */
export async function documentCid(doc: AssociationSetDocument): Promise<string> {
  const digest = await sha256.digest(encodeDocument(doc));
  return CID.create(1, raw.code, digest).toString();
}
