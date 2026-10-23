import type { Address, Hex, PublicClient, WalletClient } from 'viem';

import { entrypointAbi } from './chain.js';
import type { Withdrawal } from './crypto.js';
import type { SolidityProof } from './prover.js';

/**
 * Submits a session withdrawal on the agent's behalf, so the fresh session address never needs
 * gas and never sends a transaction of its own.
 */
export interface Relayer {
  /** Receives the relay fee. */
  feeRecipient: Address;
  /** Fee in basis points of the withdrawn amount; must not exceed the pool's maxRelayFeeBPS. */
  relayFeeBPS: bigint;
  relay(withdrawal: Withdrawal, proof: SolidityProof, scope: bigint): Promise<Hex>;
}

/**
 * Relays directly from a wallet you control, e.g. during development or when an operator runs
 * its own relayer. The wallet pays gas; it learns nothing it could not see on-chain anyway.
 */
export class WalletRelayer implements Relayer {
  constructor(
    private readonly wallet: WalletClient,
    private readonly publicClient: PublicClient,
    private readonly entrypoint: Address,
    readonly relayFeeBPS: bigint = 0n,
    readonly feeRecipient: Address = wallet.account!.address,
  ) {}

  async relay(withdrawal: Withdrawal, proof: SolidityProof, scope: bigint): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.entrypoint,
      abi: entrypointAbi,
      functionName: 'relay',
      args: [
        withdrawal,
        {
          pA: proof.pA.map(BigInt) as [bigint, bigint],
          pB: proof.pB.map((r) => r.map(BigInt)) as [[bigint, bigint], [bigint, bigint]],
          pC: proof.pC.map(BigInt) as [bigint, bigint],
          pubSignals: proof.pubSignals.map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
        },
        scope,
      ],
      account: this.wallet.account!,
      chain: this.wallet.chain,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`relay reverted: ${hash}`);
    return hash;
  }
}
