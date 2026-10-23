import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as snarkjs from 'snarkjs';
import type { Hex } from 'viem';

import type { MerkleProof, Secrets } from './crypto.js';

/**
 * SHA-256 of the withdrawal circuit artifacts from the Privacy Pools trusted setup.
 * Copied from the 0xbow SDK's pinned manifest (`packages/sdk/src/circuits/artifactHashes.ts`).
 * Artifacts that do not match are refused: a wrong proving key would produce proofs the on-chain
 * verifier rejects, and a tampered one could leak secrets.
 */
export const WITHDRAW_ARTIFACT_HASHES = {
  wasm: '36cda22791def3d520a55c0fc808369cd5849532a75fab65686e666ed3d55c10',
  zkey: '2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677',
  vkey: '666bd0983b20c1611543b04f7712e067fbe8cad69f07ada8a310837ff398d21e',
} as const;

export interface ArtifactPaths {
  wasm: string;
  zkey: string;
  vkey: string;
}

/** Artifacts from the pinned Privacy Pools submodule in this repo. */
export function defaultArtifactPaths(): ArtifactPaths {
  const circuits = resolve(
    import.meta.dirname,
    '../../../contracts/lib/privacy-pools-core/packages/circuits',
  );
  return {
    wasm: resolve(circuits, 'build/withdraw/withdraw_js/withdraw.wasm'),
    zkey: resolve(circuits, 'trusted-setup/final-keys/withdraw.zkey'),
    vkey: resolve(circuits, 'trusted-setup/final-keys/withdraw.vkey'),
  };
}

function loadVerified(path: string, expected: string): Uint8Array {
  const bytes = readFileSync(path);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`circuit artifact hash mismatch for ${path}`);
  return new Uint8Array(bytes);
}

export interface WithdrawalInputs {
  withdrawnValue: bigint;
  stateProof: MerkleProof;
  aspProof: MerkleProof;
  context: bigint;
  label: bigint;
  existingValue: bigint;
  existing: Secrets;
  next: Secrets;
}

/** Proof in the shape `ProofLib.WithdrawProof` expects on-chain. */
export interface SolidityProof {
  pA: [Hex, Hex];
  pB: [[Hex, Hex], [Hex, Hex]];
  pC: [Hex, Hex];
  pubSignals: [Hex, Hex, Hex, Hex, Hex, Hex, Hex, Hex];
}

const hex = (v: string | bigint): Hex => `0x${BigInt(v).toString(16).padStart(64, '0')}`;

export class WithdrawalProver {
  private wasm: Uint8Array;
  private zkey: Uint8Array;
  private vkey: unknown;

  constructor(paths: ArtifactPaths = defaultArtifactPaths()) {
    this.wasm = loadVerified(paths.wasm, WITHDRAW_ARTIFACT_HASHES.wasm);
    this.zkey = loadVerified(paths.zkey, WITHDRAW_ARTIFACT_HASHES.zkey);
    this.vkey = JSON.parse(new TextDecoder().decode(loadVerified(paths.vkey, WITHDRAW_ARTIFACT_HASHES.vkey)));
  }

  async prove(i: WithdrawalInputs): Promise<{ proof: SolidityProof; publicSignals: string[] }> {
    const input = {
      withdrawnValue: i.withdrawnValue,
      stateRoot: i.stateProof.root,
      stateTreeDepth: BigInt(i.stateProof.depth),
      ASPRoot: i.aspProof.root,
      ASPTreeDepth: BigInt(i.aspProof.depth),
      context: i.context,
      label: i.label,
      existingValue: i.existingValue,
      existingNullifier: i.existing.nullifier,
      existingSecret: i.existing.secret,
      newNullifier: i.next.nullifier,
      newSecret: i.next.secret,
      stateSiblings: i.stateProof.siblings,
      stateIndex: BigInt(i.stateProof.index),
      ASPSiblings: i.aspProof.siblings,
      ASPIndex: BigInt(i.aspProof.index),
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, this.wasm, this.zkey);
    // Check locally before spending gas; the on-chain verifier uses the same key.
    if (!(await snarkjs.groth16.verify(this.vkey, publicSignals, proof))) {
      throw new Error('generated withdrawal proof failed local verification');
    }
    return {
      publicSignals,
      proof: {
        pA: [hex(proof.pi_a[0]), hex(proof.pi_a[1])],
        // snarkjs orders G2 coordinates opposite to the Solidity verifier
        pB: [
          [hex(proof.pi_b[0][1]), hex(proof.pi_b[0][0])],
          [hex(proof.pi_b[1][1]), hex(proof.pi_b[1][0])],
        ],
        pC: [hex(proof.pi_c[0]), hex(proof.pi_c[1])],
        pubSignals: publicSignals.map(hex) as SolidityProof['pubSignals'],
      },
    };
  }
}
