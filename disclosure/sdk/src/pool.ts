import { type PoolNote, depositSecrets, generateMasterKeys, withdrawalSecrets } from '@sodi/rx402';
import { commitmentHash, nullifierHash, precommitmentHash } from '@sodi/rx402';
import { type Address, type Hex, type PublicClient, decodeEventLog, parseAbi, parseAbiItem } from 'viem';

import type { PoolDisclosure } from './types.js';

const poolDeposited = parseAbiItem(
  'event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)',
);
const poolWithdrawn = parseAbiItem(
  'event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)',
);
const poolNullifiers = parseAbi(['function nullifierHashes(uint256) view returns (bool)']);
const relayed = parseAbiItem(
  'event WithdrawalRelayed(address indexed _relayer, address indexed _recipient, address indexed _asset, uint256 _amount, uint256 _feeAmount)',
);

/**
 * Builds a source-of-funds disclosure for one rx402 deposit: the secrets of the deposit and of each
 * change commitment after it. This links exactly that deposit to the sessions it funded. Other
 * deposits by the same owner stay private, because their secrets are derived independently.
 */
export async function disclosePoolNote(opts: {
  publicClient: PublicClient;
  mnemonic: string;
  pool: Address;
  entrypoint: Address;
  note: PoolNote;
}): Promise<PoolDisclosure> {
  const keys = generateMasterKeys(opts.mnemonic);
  const scope = BigInt(opts.note.scope);
  const label = BigInt(opts.note.label);
  const chain = [depositSecrets(keys, scope, BigInt(opts.note.depositIndex))];
  for (let i = 0; i < opts.note.spendCount; i++) chain.push(withdrawalSecrets(keys, label, BigInt(i)));
  return {
    chainId: await opts.publicClient.getChainId(),
    pool: opts.pool,
    entrypoint: opts.entrypoint,
    depositTx: opts.note.depositTx,
    label: opts.note.label,
    chain: chain.map((s) => ({ nullifier: s.nullifier.toString(), secret: s.secret.toString() })),
  };
}

export interface VerifiedPoolHistory {
  depositor: Address;
  deposited: bigint;
  sessions: { tx: Hex; recipient: Address; withdrawn: bigint; fee: bigint }[];
  remaining: bigint;
}

/**
 * Auditor side: checks every claim against the chain. The deposit's commitment must hash from the
 * disclosed secrets; each withdrawal must spend the previous commitment's nullifier and create the next
 * commitment. Anything that does not match is rejected, so an owner cannot claim someone else's sessions.
 */
export async function verifyPoolDisclosure(
  publicClient: PublicClient,
  d: PoolDisclosure,
  fromBlock: bigint,
): Promise<VerifiedPoolHistory> {
  if ((await publicClient.getChainId()) !== d.chainId) throw new Error('disclosure is for a different chain');
  const label = BigInt(d.label);
  const secrets = d.chain.map((s) => ({ nullifier: BigInt(s.nullifier), secret: BigInt(s.secret) }));

  const receipt = await publicClient.getTransactionReceipt({ hash: d.depositTx });
  const dep = receipt.logs
    .filter((l) => l.address.toLowerCase() === d.pool.toLowerCase())
    .map((l) => {
      try {
        return decodeEventLog({ abi: [poolDeposited], data: l.data, topics: l.topics });
      } catch {
        return null;
      }
    })
    .find((e) => e && e.args._label === label);
  if (!dep) throw new Error('deposit not found in the given transaction');
  let value = dep.args._value;
  if (commitmentHash(value, label, secrets[0]!) !== dep.args._commitment) {
    throw new Error('deposit commitment does not match the disclosed secrets');
  }
  if (precommitmentHash(secrets[0]!) !== dep.args._precommitmentHash) throw new Error('precommitment mismatch');

  const withdrawals = await publicClient.getLogs({ address: d.pool, event: poolWithdrawn, fromBlock });
  const sessions: VerifiedPoolHistory['sessions'] = [];
  for (let i = 1; i < secrets.length; i++) {
    const spent = nullifierHash(secrets[i - 1]!.nullifier);
    const w = withdrawals.find((x) => x.args._spentNullifier === spent);
    if (!w) throw new Error(`withdrawal ${i} not found on-chain`);
    const remaining = value - w.args._value!;
    if (commitmentHash(remaining, label, secrets[i]!) !== w.args._newCommitment) {
      throw new Error(`withdrawal ${i} change commitment does not match the disclosed secrets`);
    }
    const r = await publicClient.getTransactionReceipt({ hash: w.transactionHash });
    const rel = r.logs
      .filter((l) => l.address.toLowerCase() === d.entrypoint.toLowerCase())
      .map((l) => {
        try {
          return decodeEventLog({ abi: [relayed], data: l.data, topics: l.topics });
        } catch {
          return null;
        }
      })
      .find(Boolean);
    sessions.push({
      tx: w.transactionHash,
      recipient: (rel?.args._recipient ?? w.args._processooor!) as Address,
      withdrawn: w.args._value!,
      fee: rel?.args._feeAmount ?? 0n,
    });
    value = remaining;
  }
  // The history must be complete: the last disclosed commitment must still be unspent. Otherwise a
  // later withdrawal (or ragequit) was left out, and "remaining" would be wrong.
  const lastSpent = await publicClient.readContract({
    address: d.pool,
    abi: poolNullifiers,
    functionName: 'nullifierHashes',
    args: [nullifierHash(secrets.at(-1)!.nullifier)],
  });
  if (lastSpent) throw new Error('disclosure is incomplete: a later withdrawal from this deposit was not disclosed');
  return { depositor: dep.args._depositor, deposited: dep.args._value, sessions, remaining: value };
}
