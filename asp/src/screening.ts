/** A deposit seen on-chain, as tracked by the approval service. */
export interface DepositRecord {
  pool: string;
  label: string; // decimal string of the uint256 label
  /**
   * Who funded the deposit. For a deposit made through a trusted forwarder (the recycler or the
   * yield router), the address the forwarder says it took the funds from, not the forwarder.
   */
  depositor: string;
  /**
   * How the depositor was established:
   *  eoa                an ordinary account, screened as itself
   *  contract           a contract (a Safe, say), screened as itself
   *  forwarded          made through the trusted forwarder in `via`; `depositor` comes from its event
   *  unresolved         made through a trusted forwarder, but no matching event names the real depositor
   *  unknown-forwarder  a contract that emitted its own event about this deposit, as a forwarder does,
   *                     so it may be depositing for someone the service can't see
   * Absent on records from before this was tracked; they are classified on the next cycle.
   */
  kind?: 'eoa' | 'contract' | 'forwarded' | 'unresolved' | 'unknown-forwarder';
  via?: string;
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
  /**
   * Lower-cased contracts allowed to deposit even though they look like forwarders (they emit their own
   * event about the deposit). Ordinary contracts such as Safes don't need to be listed.
   */
  allowedContracts?: ReadonlySet<string>;
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
  if (deposit.kind === 'unresolved') {
    return { status: 'denied', reason: `deposited through ${deposit.via}, but no event from it names the real depositor` };
  }
  if (policy.blockedAddresses.has(deposit.depositor.toLowerCase())) {
    return { status: 'denied', reason: deposit.via ? `depositor (through ${deposit.via}) is on the block list` : 'depositor is on the block list' };
  }
  if (deposit.kind === 'unknown-forwarder' && !policy.allowedContracts?.has(deposit.depositor.toLowerCase())) {
    return { status: 'denied', reason: 'deposited by a contract that reports the deposit as made for someone else, and is not a trusted forwarder' };
  }
  if (deposit.kind === undefined) return { status: 'pending' };
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
