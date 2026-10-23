import { describe, expect, it } from 'vitest';

// The 0xbow SDK source from the pinned submodule, used as the reference implementation.
import * as sdk from '../../../../contracts/lib/privacy-pools-core/packages/sdk/src/crypto.js';
import {
  commitmentHash,
  depositSecrets,
  generateMasterKeys,
  merkleProof,
  withdrawalContext,
  withdrawalSecrets,
} from '../../src/crypto.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const SCOPE = 15275348139274045583819307907082263242021424355600177454175009643064466885852n;

describe('parity with the 0xbow Privacy Pools SDK', () => {
  const ours = generateMasterKeys(MNEMONIC);
  const theirs = sdk.generateMasterKeys(MNEMONIC);

  it('derives the same master keys', () => {
    expect(ours.masterNullifier).toBe(theirs.masterNullifier);
    expect(ours.masterSecret).toBe(theirs.masterSecret);
  });

  it('derives the same deposit and withdrawal secrets', () => {
    expect(depositSecrets(ours, SCOPE, 3n)).toEqual(sdk.generateDepositSecrets(theirs, SCOPE as never, 3n));
    expect(withdrawalSecrets(ours, 777n, 2n)).toEqual(sdk.generateWithdrawalSecrets(theirs, 777n as never, 2n));
  });

  it('computes the same commitment hash', () => {
    const s = depositSecrets(ours, SCOPE, 0n);
    const ref = sdk.getCommitment(1_000_000n, 42n, s.nullifier as never, s.secret as never);
    expect(commitmentHash(1_000_000n, 42n, s)).toBe(ref.hash);
  });

  it('computes the same withdrawal context', () => {
    const w = { processooor: '0xaCa6B50b648a6f575a009DC7c97aBe62808869Ce' as const, data: '0x1234' as const };
    expect(withdrawalContext(w, SCOPE)).toBe(BigInt(sdk.calculateContext(w, SCOPE as never)));
  });

  it('builds the same padded Merkle proof', () => {
    const leaves = [11n, 22n, 33n, 44n, 55n];
    const ref = sdk.generateMerkleProof(leaves, 33n);
    const p = merkleProof(leaves, 33n);
    expect(p.root).toBe(ref.root);
    expect(p.index).toBe(ref.index);
    expect(p.siblings).toEqual(ref.siblings);
    expect(p.siblings).toHaveLength(32);
  });
});
