import { encodeAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';

import { type RelayerSettings, checkTerms, parseRelayRequest } from '../src/relay.js';

const ENTRYPOINT = '0xaCa6B50b648a6f575a009DC7c97aBe62808869Ce';
const RELAYER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const SESSION = '0x00000000000000000000000000000000000000aa';
const SCOPE = 123n;

const settings: RelayerSettings = {
  entrypoint: ENTRYPOINT,
  pools: new Map([[SCOPE, '0x8cddbb1C33ce49aB72FD1765649835935604BF76']]),
  feeRecipient: RELAYER,
  relayFeeBPS: 50n,
  minWithdrawal: 100_000n,
};

const relayData = (feeRecipient: string, bps: bigint) =>
  encodeAbiParameters(
    [{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] }],
    [[SESSION, feeRecipient as `0x${string}`, bps]],
  );

const body = (over: { data?: string; processooor?: string; withdrawn?: string; scope?: string } = {}) => ({
  withdrawal: { processooor: over.processooor ?? ENTRYPOINT, data: over.data ?? relayData(RELAYER, 50n) },
  proof: {
    pA: ['0x1', '0x2'],
    pB: [['0x3', '0x4'], ['0x5', '0x6']],
    pC: ['0x7', '0x8'],
    pubSignals: ['0x0', '0x0', over.withdrawn ?? '1000000', '0x0', '0x0', '0x0', '0x0', '0x0'],
  },
  scope: over.scope ?? SCOPE.toString(),
});

describe('relay request checks', () => {
  it('accepts a well-formed request on our terms', () => {
    const r = checkTerms(parseRelayRequest(body()), settings);
    expect(r.recipient.toLowerCase()).toBe(SESSION);
    expect(r.withdrawn).toBe(1_000_000n);
  });

  it('accepts a fee above our minimum', () => {
    expect(() => checkTerms(parseRelayRequest(body({ data: relayData(RELAYER, 100n) })), settings)).not.toThrow();
  });

  it.each([
    ['a different processooor', { processooor: RELAYER }, /Entrypoint/],
    ['an unknown pool', { scope: '999' }, /unknown pool/],
    ['someone else as fee recipient', { data: relayData(SESSION, 50n) }, /fee recipient/],
    ['a fee below ours', { data: relayData(RELAYER, 10n) }, /relay fee below/],
    ['a dust withdrawal', { withdrawn: '99999' }, /below minimum/],
    ['data that is not RelayData', { data: '0x1234' }, /not RelayData/],
  ])('rejects %s', (_, over, msg) => {
    expect(() => checkTerms(parseRelayRequest(body(over)), settings)).toThrow(msg);
  });

  it('rejects malformed proofs', () => {
    const b = body();
    (b.proof.pubSignals as string[]).pop();
    expect(() => parseRelayRequest(b)).toThrow(/pubSignals/);
    expect(() => parseRelayRequest({ ...body(), proof: { ...body().proof, pA: ['x', 'y'] } })).toThrow(/pA/);
    expect(() => parseRelayRequest({ withdrawal: { processooor: 'nope', data: '0x' } })).toThrow(/withdrawal/);
  });
});
