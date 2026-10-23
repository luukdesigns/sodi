/**
 * Deploys the canonical token bridge between Robinhood Chain and the Sodi L3, and the WETH gateway.
 * Run after the node is up and producing blocks.
 *
 *   npm run token-bridge
 *
 * Environment:
 *   DEPLOYER_PRIVATE_KEY   the rollup owner from create-rollup
 *   SODI_RPC_URL           the L3's RPC
 *   SODI_NETWORK, PARENT_RPC_URL as for create-rollup
 *
 * Note: the standard gateway gives bridged tokens a plain ERC-20 on the L3. rx402 sessions pay x402
 * merchants with EIP-3009 transferWithAuthorization, which plain bridged tokens lack, so USDG needs a
 * custom gateway before rx402 can run on the L3. See docs/ARCHITECTURE.md, "Moving USDG".
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTokenBridge } from '@arbitrum/chain-sdk';
import { type Hex, createPublicClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { SODI_CHAINS, network } from './config.js';

const need = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`set ${n}`);
  return v;
};

const chain = SODI_CHAINS[network()];
const deploymentFile = process.env.DEPLOYMENT_FILE ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deployments', `${chain.chainId}.json`);
const deployment = JSON.parse(readFileSync(deploymentFile, 'utf8'));

const sodiRpc = need('SODI_RPC_URL');
const sodi = defineChain({
  id: chain.chainId,
  name: chain.name,
  network: `sodi-${chain.chainId}`,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [sodiRpc] }, public: { http: [sodiRpc] } },
});
const parentClient = createPublicClient({ chain: chain.parent, transport: http(process.env.PARENT_RPC_URL ?? chain.parent.rpcUrls.default.http[0]!) });
const orbitClient = createPublicClient({ chain: sodi, transport: http(sodiRpc) });
const owner = privateKeyToAccount(need('DEPLOYER_PRIVATE_KEY') as Hex);

const { tokenBridgeContracts } = await createTokenBridge({
  rollupOwner: owner.address,
  rollupAddress: deployment.coreContracts.rollup,
  rollupDeploymentBlockNumber: BigInt(deployment.deploymentBlock),
  account: owner,
  parentChainPublicClient: parentClient as never,
  orbitChainPublicClient: orbitClient as never,
});

deployment.tokenBridge = tokenBridgeContracts;
writeFileSync(deploymentFile, `${JSON.stringify(deployment, null, 2)}\n`);
console.log('Token bridge deployed:');
console.log(JSON.stringify(tokenBridgeContracts, null, 2));
