import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  decodeAbiParameters,
  isAddress,
  isHex,
} from 'viem';

import { type RecycleRequest, entrypointAbi, poolAbi, recycleArgs, recyclerAbi } from '@sodi/rx402';

export interface RelayerSettings {
  entrypoint: Address;
  /** Pools this relayer serves, keyed by scope. */
  pools: Map<bigint, Address>;
  feeRecipient: Address;
  /** Minimum fee the relayer accepts, in basis points. */
  relayFeeBPS: bigint;
  /** Smallest withdrawal worth relaying (asset base units), to avoid paying gas for dust. */
  minWithdrawal: bigint;
  /** Smallest fee worth relaying for (asset base units), so the fee covers the relayer's gas. */
  minFee?: bigint;
  /** SodiRecycler contract; recycles are accepted only when set. */
  recycler?: Address;
  /** Fee per recycle (asset base units), taken out of the recycled amount. */
  recycleFee?: bigint;
}

export interface RelayRequest {
  withdrawal: { processooor: Address; data: Hex };
  proof: {
    pA: [bigint, bigint];
    pB: [[bigint, bigint], [bigint, bigint]];
    pC: [bigint, bigint];
    pubSignals: [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  };
  scope: bigint;
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const big = (v: unknown, what: string): bigint => {
  if (typeof v !== 'string' && typeof v !== 'number') throw new RelayError(`invalid ${what}`);
  try {
    return BigInt(v);
  } catch {
    throw new RelayError(`invalid ${what}`);
  }
};

const tuple = <N extends number>(v: unknown, n: N, what: string): bigint[] => {
  if (!Array.isArray(v) || v.length !== n) throw new RelayError(`invalid ${what}`);
  return v.map((x) => big(x, what));
};

/** Parses untrusted JSON into a relay request, rejecting anything malformed. */
export function parseRelayRequest(body: unknown): RelayRequest {
  const b = body as Record<string, any>;
  const w = b?.withdrawal;
  if (!w || !isAddress(w.processooor) || !isHex(w.data)) throw new RelayError('invalid withdrawal');
  const p = b.proof;
  if (!p || !Array.isArray(p.pB) || p.pB.length !== 2) throw new RelayError('invalid proof');
  return {
    withdrawal: { processooor: w.processooor, data: w.data },
    proof: {
      pA: tuple(p.pA, 2, 'proof.pA') as [bigint, bigint],
      pB: [tuple(p.pB[0], 2, 'proof.pB'), tuple(p.pB[1], 2, 'proof.pB')] as [[bigint, bigint], [bigint, bigint]],
      pC: tuple(p.pC, 2, 'proof.pC') as [bigint, bigint],
      pubSignals: tuple(p.pubSignals, 8, 'proof.pubSignals') as RelayRequest['proof']['pubSignals'],
    },
    scope: big(b.scope, 'scope'),
  };
}

/**
 * Checks a request against the relayer's terms before anything touches the chain:
 * right Entrypoint and pool, our fee recipient, a fee at least our minimum, and a non-dust amount.
 */
export function checkTerms(req: RelayRequest, s: RelayerSettings): { recipient: Address; withdrawn: bigint } {
  if (req.withdrawal.processooor.toLowerCase() !== s.entrypoint.toLowerCase()) {
    throw new RelayError('withdrawal must be processed by the Entrypoint');
  }
  if (!s.pools.has(req.scope)) throw new RelayError('unknown pool scope');

  let recipient: Address;
  let feeRecipient: Address;
  let feeBPS: bigint;
  try {
    [[recipient, feeRecipient, feeBPS]] = decodeAbiParameters(
      [{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] }],
      req.withdrawal.data,
    ) as unknown as [[Address, Address, bigint]];
  } catch {
    throw new RelayError('withdrawal data is not RelayData');
  }
  if (feeRecipient.toLowerCase() !== s.feeRecipient.toLowerCase()) {
    throw new RelayError('fee recipient must be this relayer');
  }
  if (feeBPS < s.relayFeeBPS) throw new RelayError(`relay fee below ${s.relayFeeBPS} bps`);

  const withdrawn = req.proof.pubSignals[2];
  if (withdrawn < s.minWithdrawal) throw new RelayError(`withdrawal below minimum of ${s.minWithdrawal}`);
  if (s.minFee !== undefined && (withdrawn * feeBPS) / 10_000n < s.minFee) {
    throw new RelayError(`fee below the minimum of ${s.minFee}; withdraw more or pay a higher fee`);
  }
  return { recipient, withdrawn };
}

const hex = (v: unknown, what: string, bytes?: number): Hex => {
  if (!isHex(v) || (bytes !== undefined && v.length !== 2 + bytes * 2)) throw new RelayError(`invalid ${what}`);
  return v;
};

/** Parses untrusted JSON into a recycle request, rejecting anything malformed. */
export function parseRecycleRequest(body: unknown): RecycleRequest {
  const b = body as Record<string, any>;
  const a = b?.authorization;
  if (!a || !isAddress(a.from) || !isAddress(b.feeRecipient)) throw new RelayError('invalid recycle request');
  if (a.v !== 27 && a.v !== 28) throw new RelayError('invalid authorization.v');
  const dec = (v: unknown, what: string) => big(v, what).toString();
  return {
    authorization: {
      from: a.from,
      value: dec(a.value, 'authorization.value'),
      validAfter: dec(a.validAfter, 'authorization.validAfter'),
      validBefore: dec(a.validBefore, 'authorization.validBefore'),
      nonce: hex(a.nonce, 'authorization.nonce', 32),
      v: a.v,
      r: hex(a.r, 'authorization.r', 32),
      s: hex(a.s, 'authorization.s', 32),
    },
    precommitment: dec(b.precommitment, 'precommitment'),
    fee: dec(b.fee, 'fee'),
    feeRecipient: b.feeRecipient,
  };
}

/** A recycle on our terms: we accept them, our fee recipient, at least our fee. */
export function checkRecycleTerms(req: RecycleRequest, s: RelayerSettings): void {
  if (!s.recycler) throw new RelayError('this relayer does not submit recycles', 404);
  if (req.feeRecipient.toLowerCase() !== s.feeRecipient.toLowerCase()) throw new RelayError('fee recipient must be this relayer');
  if (BigInt(req.fee) < (s.recycleFee ?? 0n)) throw new RelayError(`recycle fee below ${s.recycleFee}`);
}

/**
 * Simulates every request first, so invalid proofs cost no gas, then sends them one at a time so
 * they never race on the relayer's nonce. Simulations run concurrently: junk requests can't hold up
 * honest ones behind them.
 */
export class RelaySubmitter {
  private sending: Promise<unknown> = Promise.resolve();
  private inFlight = 0;

  constructor(
    private readonly publicClient: PublicClient,
    private readonly wallet: WalletClient,
    private readonly settings: RelayerSettings,
    private readonly maxInFlight = 32,
  ) {}

  submit(req: RelayRequest): Promise<Hex> {
    return this.simulateAndSend('withdrawal', () =>
      this.publicClient.simulateContract({
        address: this.settings.entrypoint,
        abi: entrypointAbi,
        functionName: 'relay',
        args: [req.withdrawal, req.proof, req.scope],
        account: this.wallet.account!,
      }),
    );
  }

  submitRecycle(req: RecycleRequest): Promise<Hex> {
    if (!this.settings.recycler) throw new RelayError('this relayer does not submit recycles', 404);
    const recycler = this.settings.recycler;
    return this.simulateAndSend('recycle', () =>
      this.publicClient.simulateContract({ address: recycler, abi: recyclerAbi, functionName: 'recycle', args: recycleArgs(req), account: this.wallet.account! }),
    );
  }

  private async simulateAndSend(what: string, simulate: () => Promise<{ request: any }>): Promise<Hex> {
    if (this.inFlight >= this.maxInFlight) throw new RelayError('relayer is busy; try again shortly', 503);
    this.inFlight++;
    try {
      const account = this.wallet.account!;
      let request;
      try {
        ({ request } = await simulate());
      } catch (err) {
        const reason = err instanceof Error ? (err as { shortMessage?: string }).shortMessage ?? err.message : String(err);
        throw new RelayError(`${what} would revert: ${reason}`, 422);
      }
      // Estimates for calls into ERC-4626 vaults (Morpho, via recycles and the yield funder) can come in
      // too tight; leave headroom.
      const gas = ((await this.publicClient.estimateContractGas({ ...request, account })) * 13n) / 10n;
      const send = this.sending.then(() => this.wallet.writeContract({ ...request, gas, account, chain: this.wallet.chain }));
      this.sending = send.catch(() => {});
      const hash = await send;
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new RelayError(`${what} reverted: ${hash}`, 502);
      return hash;
    } finally {
      this.inFlight--;
    }
  }
}

/** Reads each pool's scope and confirms the relay fee fits the pool's cap. */
export async function loadPools(
  client: PublicClient,
  entrypoint: Address,
  pools: Address[],
  relayFeeBPS: bigint,
): Promise<Map<bigint, Address>> {
  const map = new Map<bigint, Address>();
  for (const pool of pools) {
    const [scope, asset] = await Promise.all([
      client.readContract({ address: pool, abi: poolAbi, functionName: 'SCOPE' }),
      client.readContract({ address: pool, abi: poolAbi, functionName: 'ASSET' }),
    ]);
    const [, , , maxRelayFeeBPS] = await client.readContract({
      address: entrypoint,
      abi: entrypointAbi,
      functionName: 'assetConfig',
      args: [asset],
    });
    if (relayFeeBPS > maxRelayFeeBPS) {
      throw new Error(`RELAY_FEE_BPS ${relayFeeBPS} exceeds pool ${pool} cap of ${maxRelayFeeBPS}`);
    }
    map.set(scope, pool);
  }
  return map;
}
