import type { Address, Hex } from 'viem';

import type { Withdrawal } from './crypto.js';
import type { SolidityProof } from './prover.js';
import type { Relayer } from './relayer.js';

export interface RelayQuote {
  chainId: number;
  entrypoint: Address;
  feeRecipient: Address;
  relayFeeBPS: string;
  minWithdrawal: string;
}

/**
 * Relays through a Sodi relayer service over HTTP. Call `HttpRelayer.connect(url)` to fetch the
 * relayer's fee terms first: they are baked into the withdrawal the proof commits to.
 */
export class HttpRelayer implements Relayer {
  private constructor(
    private readonly baseUrl: string,
    readonly feeRecipient: Address,
    readonly relayFeeBPS: bigint,
    readonly quote: RelayQuote,
  ) {}

  static async connect(baseUrl: string): Promise<HttpRelayer> {
    const res = await fetch(new URL('/quote', baseUrl));
    if (!res.ok) throw new Error(`relayer quote failed: ${res.status}`);
    const quote = (await res.json()) as RelayQuote;
    return new HttpRelayer(baseUrl, quote.feeRecipient, BigInt(quote.relayFeeBPS), quote);
  }

  async relay(withdrawal: Withdrawal, proof: SolidityProof, scope: bigint): Promise<Hex> {
    const res = await fetch(new URL('/relay', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ withdrawal, proof, scope: scope.toString() }),
    });
    const body = (await res.json()) as { txHash?: Hex; error?: string };
    if (!res.ok || !body.txHash) throw new Error(`relayer rejected the withdrawal: ${body.error ?? res.status}`);
    return body.txHash;
  }
}
