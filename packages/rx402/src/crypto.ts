import { LeanIMT } from '@zk-kit/lean-imt';
import { poseidon } from 'maci-crypto/build/ts/hashing.js';
import { bytesToBigInt, encodeAbiParameters, type Address, type Hex, keccak256 } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

/**
 * Key derivation and commitment hashing for Privacy Pools.
 *
 * These mirror the 0xbow Privacy Pools SDK (`packages/sdk/src/crypto.ts`) exactly, so a mnemonic
 * used with rx402 recovers the same deposits in any Privacy Pools-compatible wallet.
 */

export const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface MasterKeys {
  masterNullifier: bigint;
  masterSecret: bigint;
}

export interface Secrets {
  nullifier: bigint;
  secret: bigint;
}

export function generateMasterKeys(mnemonic: string): MasterKeys {
  if (!mnemonic) throw new Error('mnemonic is required');
  const key1 = bytesToBigInt(mnemonicToAccount(mnemonic, { accountIndex: 0 }).getHdKey().privateKey!);
  const key2 = bytesToBigInt(mnemonicToAccount(mnemonic, { accountIndex: 1 }).getHdKey().privateKey!);
  return { masterNullifier: poseidon([key1]), masterSecret: poseidon([key2]) };
}

/** Secrets for the n-th deposit into a pool (identified by its scope). */
export function depositSecrets(keys: MasterKeys, scope: bigint, index: bigint): Secrets {
  return {
    nullifier: poseidon([keys.masterNullifier, scope, index]),
    secret: poseidon([keys.masterSecret, scope, index]),
  };
}

/** Secrets for the commitment left behind by the n-th withdrawal from a deposit (identified by label). */
export function withdrawalSecrets(keys: MasterKeys, label: bigint, index: bigint): Secrets {
  return {
    nullifier: poseidon([keys.masterNullifier, label, index]),
    secret: poseidon([keys.masterSecret, label, index]),
  };
}

export function precommitmentHash({ nullifier, secret }: Secrets): bigint {
  return poseidon([nullifier, secret]);
}

export function commitmentHash(value: bigint, label: bigint, secrets: Secrets): bigint {
  return poseidon([value, label, precommitmentHash(secrets)]);
}

/** Poseidon hash of the nullifier, published on withdrawal to prevent double spends. */
export function nullifierHash(nullifier: bigint): bigint {
  return poseidon([nullifier]);
}

export interface MerkleProof {
  root: bigint;
  depth: number;
  index: number;
  siblings: bigint[]; // padded to 32
}

export const MAX_TREE_DEPTH = 32;

/** LeanIMT inclusion proof, padded to the circuit's 32 levels. */
export function merkleProof(leaves: readonly bigint[], leaf: bigint): MerkleProof {
  const tree = new LeanIMT<bigint>((a, b) => poseidon([a, b]));
  tree.insertMany([...leaves]);
  const index = tree.indexOf(leaf);
  if (index === -1) throw new Error('leaf not found in tree');
  const proof = tree.generateProof(index);
  const siblings = [...proof.siblings];
  while (siblings.length < MAX_TREE_DEPTH) siblings.push(0n);
  return { root: tree.root, depth: tree.depth, index: proof.index, siblings };
}

export interface Withdrawal {
  processooor: Address;
  data: Hex;
}

/** Binds the proof to this exact withdrawal (recipient, fees) and pool. */
export function withdrawalContext(withdrawal: Withdrawal, scope: bigint): bigint {
  const encoded = encodeAbiParameters(
    [
      {
        name: 'withdrawal',
        type: 'tuple',
        components: [
          { name: 'processooor', type: 'address' },
          { name: 'data', type: 'bytes' },
        ],
      },
      { name: 'scope', type: 'uint256' },
    ],
    [withdrawal, scope],
  );
  return BigInt(keccak256(encoded)) % SNARK_SCALAR_FIELD;
}

/** Random field element, used for nonces that must not repeat. */
export function randomFieldElement(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBigInt(bytes) % SNARK_SCALAR_FIELD;
}
