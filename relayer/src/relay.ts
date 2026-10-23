import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  decodeAbiParameters,
  isAddress,
  isHex,
} from 'viem';

import { entrypointAbi, poolAbi } from '@sodi/rx402';

export interface RelayerSettings {
  entrypoint: Address;
  /** Pools this relayer serves, keyed by scope. */
  pools: Map<bigint, Address>;
  feeRecipient: Address;
  /** Minimum fee the relayer accepts, in basis points. */
  relayFeeBPS: bigint;
  /** Smallest withdrawal worth relaying (asset base units), to avoid paying gas for dust. */
  minWithdrawal: bigint;
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
  return { recipient, withdrawn };
}

/**
 * Sends relays one at a time, so concurrent requests never race on the relayer's nonce,
 * and simulates each one first so invalid proofs cost no gas.
 */
export class RelaySubmitter {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly publicClient: PublicClient,
    private readonly wallet: WalletClient,
    private readonly settings: RelayerSettings,
  ) {}

  submit(req: RelayRequest): Promise<Hex> {
    const run = this.queue.then(() => this.send(req));
    this.queue = run.catch(() => {});
    return run;
  }

  private async send(req: RelayRequest): Promise<Hex> {
    const account = this.wallet.account!;
    let request;
    try {
      ({ request } = await this.publicClient.simulateContract({
        address: this.settings.entrypoint,
        abi: entrypointAbi,
        functionName: 'relay',
        args: [req.withdrawal, req.proof, req.scope],
        account,
      }));
    } catch (err) {
      const reason = err instanceof Error ? (err as { shortMessage?: string }).shortMessage ?? err.message : String(err);
      throw new RelayError(`withdrawal would revert: ${reason}`, 422);
    }
    const hash = await this.wallet.writeContract({ ...request, account, chain: this.wallet.chain });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new RelayError(`relay reverted: ${hash}`, 502);
    return hash;
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
