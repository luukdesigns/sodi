import type { Address } from 'viem';

import type { PoolWalletConfig } from './wallet.js';

/** The parts of a Sodi deployment file the SDK needs. */
export interface SodiDeployment {
  chainId: number;
  deploymentBlock: number;
  contracts: { Entrypoint: Address; SodiRecycler?: Address; SodiYieldDepositor?: Address };
  pools: Record<string, { pool: Address; asset: Address; depositAsset?: Address }>;
  yieldPool?: { vault: Address; pool: Address; router: Address; funder: Address; block: number };
  forwarders?: Address[];
}

/**
 * The pool settings for `name` in a deployment file: `USDG` for the plain pool, `syUSDG` for the yield
 * pool. For the yield pool, `asset` is still USDG (what goes in and comes out), and `yieldPool` holds
 * the vault, router and funder.
 */
export function poolFromDeployment(
  d: SodiDeployment,
  name = 'USDG',
): Pick<PoolWalletConfig, 'entrypoint' | 'pool' | 'asset' | 'poolDeploymentBlock' | 'yieldPool'> {
  const p = d.pools[name];
  if (!p) throw new Error(`no pool ${name} in the deployment (have ${Object.keys(d.pools).join(', ')})`);
  const y = d.yieldPool;
  if (y && p.pool.toLowerCase() === y.pool.toLowerCase()) {
    return {
      entrypoint: d.contracts.Entrypoint,
      pool: p.pool,
      asset: p.depositAsset ?? d.pools.USDG!.asset,
      poolDeploymentBlock: BigInt(y.block),
      yieldPool: { vault: y.vault, router: y.router, funder: y.funder },
    };
  }
  return { entrypoint: d.contracts.Entrypoint, pool: p.pool, asset: p.asset, poolDeploymentBlock: BigInt(d.deploymentBlock) };
}
