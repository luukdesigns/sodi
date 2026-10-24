import type { Address, Hex } from 'viem';

import type { Withdrawal } from './crypto.js';
import type { SolidityProof } from './prover.js';
import type { RecycleRequest, RecycleSubmitter } from './recycle.js';
import type { Relayer } from './relayer.js';

export interface RelayQuote {
  chainId: number;
  entrypoint: Address;
  feeRecipient: Address;
  relayFeeBPS: string;
  minWithdrawal: string;
  /** Present when the relayer submits recycles. */
  recycler?: Address;
  recycleFee?: string;
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

  /**
   * The fee recipient and fee are written into every withdrawal, which is public. A relayer that gave
   * each client its own recipient or an unusual fee could tag all of that client's sessions, so pin
   * the terms you expect (`feeRecipient`, `maxFeeBPS`) when you know them.
   */
  static async connect(
    baseUrl: string,
    expect: { chainId?: number; entrypoint?: Address; feeRecipient?: Address; maxFeeBPS?: bigint } = {},
  ): Promise<HttpRelayer> {
    const res = await fetch(new URL('/quote', baseUrl));
    if (!res.ok) throw new Error(`relayer quote failed: ${res.status}`);
    const quote = (await res.json()) as RelayQuote;
    const same = (a?: string, b?: string) => !a || !b || a.toLowerCase() === b.toLowerCase();
    if (expect.chainId !== undefined && quote.chainId !== expect.chainId) throw new Error(`relayer is for chain ${quote.chainId}, expected ${expect.chainId}`);
    if (!same(expect.entrypoint, quote.entrypoint)) throw new Error('relayer serves a different entrypoint');
    if (!same(expect.feeRecipient, quote.feeRecipient)) throw new Error(`relayer fee recipient ${quote.feeRecipient} is not the expected ${expect.feeRecipient}`);
    const fee = BigInt(quote.relayFeeBPS);
    if (expect.maxFeeBPS !== undefined && fee > expect.maxFeeBPS) throw new Error(`relayer fee ${fee} bps is above the expected ${expect.maxFeeBPS}`);
    return new HttpRelayer(baseUrl, quote.feeRecipient, fee, quote);
  }

  /**
   * Submits recycles through this relayer, if it offers them. Pin the recycler you expect: a relayer
   * could otherwise point clients at a contract of its own.
   */
  recycleSubmitter(expect: { recycler: Address; maxFee?: bigint }): RecycleSubmitter {
    const { recycler, recycleFee } = this.quote;
    if (!recycler) throw new Error('this relayer does not submit recycles');
    if (recycler.toLowerCase() !== expect.recycler.toLowerCase()) throw new Error(`relayer uses recycler ${recycler}, not ${expect.recycler}`);
    const fee = BigInt(recycleFee ?? '0');
    if (expect.maxFee !== undefined && fee > expect.maxFee) throw new Error(`relayer recycle fee ${fee} is above ${expect.maxFee}`);
    const baseUrl = this.baseUrl;
    return {
      recycler: expect.recycler,
      recycleFee: fee,
      feeRecipient: this.feeRecipient,
      async recycle(req: RecycleRequest): Promise<Hex> {
        const res = await fetch(new URL('/recycle', baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
        const body = (await res.json()) as { txHash?: Hex; error?: string };
        if (!res.ok || !body.txHash) throw new Error(`relayer rejected the recycle: ${body.error ?? res.status}`);
        return body.txHash;
      },
    };
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
