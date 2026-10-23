import { describe, expect, it } from 'vitest';

import { type DepositRecord, type ScreeningPolicy, approvedLabels, screen } from '../src/screening.js';

const deposit = (over: Partial<DepositRecord> = {}): DepositRecord => ({
  pool: '0xpool',
  label: '111',
  depositor: '0xabc',
  value: '1000000',
  commitment: '1',
  blockNumber: 10,
  logIndex: 0,
  txHash: '0xtx',
  timestamp: 1_000,
  status: 'pending',
  ...over,
});

const policy = (over: Partial<ScreeningPolicy> = {}): ScreeningPolicy => ({
  blockedAddresses: new Set(),
  deniedLabels: new Set(),
  vettingDelaySeconds: 1800,
  ...over,
});

describe('screen', () => {
  it('keeps a deposit pending during the vetting window', () => {
    expect(screen(deposit(), policy(), 1_000 + 1799).status).toBe('pending');
  });

  it('approves once the window has passed', () => {
    expect(screen(deposit(), policy(), 1_000 + 1800).status).toBe('approved');
  });

  it('denies a blocked depositor regardless of case', () => {
    const r = screen(deposit({ depositor: '0xABC' }), policy({ blockedAddresses: new Set(['0xabc']) }), 9_999);
    expect(r.status).toBe('denied');
    expect(r.reason).toMatch(/block list/);
  });

  it('denies a label rejected by an operator', () => {
    expect(screen(deposit(), policy({ deniedLabels: new Set(['111']) }), 9_999).status).toBe('denied');
  });

  it('revokes an earlier approval when the depositor is later blocked', () => {
    const d = deposit({ status: 'approved' });
    expect(screen(d, policy({ blockedAddresses: new Set(['0xabc']) }), 9_999).status).toBe('denied');
  });

  it('never automatically re-approves a denied deposit', () => {
    const d = deposit({ status: 'denied', reason: 'manual' });
    expect(screen(d, policy(), 9_999)).toEqual({ status: 'denied', reason: 'manual' });
  });
});

describe('approvedLabels', () => {
  it('returns only approved labels, in on-chain order', () => {
    const labels = approvedLabels([
      deposit({ label: '3', blockNumber: 12, status: 'approved' }),
      deposit({ label: '2', blockNumber: 11, logIndex: 1, status: 'approved' }),
      deposit({ label: '9', blockNumber: 11, logIndex: 0, status: 'pending' }),
      deposit({ label: '1', blockNumber: 11, logIndex: 0, status: 'approved' }),
      deposit({ label: '7', blockNumber: 5, status: 'denied' }),
    ]);
    expect(labels).toEqual([1n, 2n, 3n]);
  });
});
