/**
 * Sodi L3 parameters. Everything that is fixed at genesis lives here, so it can be reviewed in one place.
 *
 * Chain IDs 76340 (testnet) and 7634 (mainnet, "SODI" on a phone keypad) were unregistered in
 * ethereum-lists/chains when this was written. Check again, and register, before deploying.
 */
import { prepareChainConfig, createRollupPrepareDeploymentParamsConfig } from '@arbitrum/chain-sdk';
import { rhMainnet, rhTestnet } from '@arbitrum/chain-sdk/chains';
import { type Address, type Chain, type PublicClient, parseEther } from 'viem';

export type Network = 'testnet' | 'mainnet';

export interface SodiChain {
  chainId: number;
  name: string;
  parent: Chain;
  /** Validator bond, in the parent chain's WETH. */
  baseStake: bigint;
  /**
   * Rollup posts all data to Robinhood Chain. AnyTrust (a data availability committee) is cheaper but
   * adds a trust assumption; see docs/ARCHITECTURE.md. This is fixed at genesis.
   */
  anyTrust: boolean;
}

export const SODI_CHAINS: Record<Network, SodiChain> = {
  testnet: {
    chainId: 76340,
    name: 'Sodi Testnet',
    parent: rhTestnet,
    baseStake: parseEther('0.0001'),
    anyTrust: false,
  },
  mainnet: {
    chainId: 7634,
    name: 'Sodi',
    parent: rhMainnet,
    baseStake: parseEther('1'),
    anyTrust: false,
  },
};

/** Robinhood Chain addresses the Arbitrum chain SDK ships with, recorded here for review. */
export const PARENT_FACTORIES = {
  46630: {
    rollupCreator: '0xF5962AD061A1aD6F38F340F5b267b3593cC1Cd7B',
    tokenBridgeCreator: '0xB27b615369d2B846183c36AD8406B4DD7990fb70',
    weth: '0x7943e237c7F95DA44E0301572D358911207852Fa',
  },
  4663: {
    rollupCreator: '0xF5962AD061A1aD6F38F340F5b267b3593cC1Cd7B',
    tokenBridgeCreator: '0x8B1EFf64E1eAd493A82C6798f5708183AF91A3AD',
    weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  },
} as const satisfies Record<number, Record<string, Address>>;

export function network(): Network {
  const n = process.env.SODI_NETWORK ?? 'testnet';
  if (n !== 'testnet' && n !== 'mainnet') throw new Error(`SODI_NETWORK must be testnet or mainnet, got ${n}`);
  return n;
}

/** The full createRollup config for a Sodi chain, owned by `owner`. */
export function rollupConfig(parentClient: PublicClient, chain: SodiChain, owner: Address) {
  const chainConfig = prepareChainConfig({
    chainId: chain.chainId,
    arbitrum: {
      InitialChainOwner: owner,
      DataAvailabilityCommittee: chain.anyTrust,
    },
  });
  const weth = PARENT_FACTORIES[chain.parent.id as keyof typeof PARENT_FACTORIES].weth;
  return createRollupPrepareDeploymentParamsConfig(parentClient, {
    chainId: BigInt(chain.chainId),
    owner,
    chainConfig,
    // Challenge window, assertion period and inbox timing use the SDK's defaults for Robinhood Chain:
    // 30 minutes on testnet, 7 days on mainnet, measured in L1 blocks as Arbitrum parents report them.
    stakeToken: weth,
    baseStake: chain.baseStake,
  });
}
