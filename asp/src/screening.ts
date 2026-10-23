/** A deposit seen on-chain, as tracked by the approval service. */
export interface DepositRecord {
  pool: string;
  label: string; // decimal string of the uint256 label
  depositor: string;
  value: string;
  commitment: string;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  timestamp: number; // block timestamp, seconds
  status: 'pending' | 'approved' | 'denied';
  reason?: string;
}

export interface ScreeningPolicy {
  /** Lower-cased depositor addresses that are never approved (sanctions, known exploits). */
  blockedAddresses: ReadonlySet<string>;
  /** Labels that operators have explicitly rejected. */
  deniedLabels: ReadonlySet<string>;
  /** Seconds a deposit must wait before approval, giving operators a window to deny it. */
  vettingDelaySeconds: number;
}

/**
 * Decides a deposit's status. Denials are sticky: once a deposit is blocked it is never
 * re-approved automatically. Approvals can be revoked if the depositor or label is later
 * added to the block lists, which removes the label from the next published set.
 */
export function screen(
  deposit: DepositRecord,
  policy: ScreeningPolicy,
  nowSeconds: number,
): Pick<DepositRecord, 'status' | 'reason'> {
  if (policy.blockedAddresses.has(deposit.depositor.toLowerCase())) {
    return { status: 'denied', reason: 'depositor is on the block list' };
  }
  if (policy.deniedLabels.has(deposit.label)) {
    return { status: 'denied', reason: 'label denied by operator' };
  }
  if (deposit.status === 'denied') return { status: 'denied', reason: deposit.reason };
  if (nowSeconds - deposit.timestamp < policy.vettingDelaySeconds) {
    return { status: 'pending' };
  }
  return { status: 'approved' };
}

/** Approved labels in on-chain deposit order, so the tree is deterministic. */
export function approvedLabels(deposits: readonly DepositRecord[]): bigint[] {
  return deposits
    .filter((d) => d.status === 'approved')
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    .map((d) => BigInt(d.label));
}
