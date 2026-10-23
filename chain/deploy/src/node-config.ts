/**
 * Writes the Nitro node config for a deployed Sodi chain.
 *
 *   npm run node-config
 *
 * The config contains the batch poster and validator private keys, so it is written OUTSIDE the
 * repo (NODE_CONFIG_DIR, default ~/.sodi-chain/<chainId>/). Never commit it.
 *
 * Environment:
 *   BATCH_POSTER_PRIVATE_KEY, VALIDATOR_PRIVATE_KEY
 *   SODI_NETWORK, PARENT_RPC_URL as for create-rollup
 *   DAS_SERVER_URL         only for AnyTrust chains
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareNodeConfig } from '@arbitrum/chain-sdk';

import { SODI_CHAINS, network } from './config.js';

const need = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`set ${n}`);
  return v;
};

const chain = SODI_CHAINS[network()];
const deploymentFile = process.env.DEPLOYMENT_FILE ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deployments', `${chain.chainId}.json`);
const deployment = JSON.parse(readFileSync(deploymentFile, 'utf8'));

const nodeConfig = prepareNodeConfig({
  chainName: chain.name,
  chainConfig: deployment.chainConfig,
  coreContracts: deployment.coreContracts,
  batchPosterPrivateKey: need('BATCH_POSTER_PRIVATE_KEY'),
  validatorPrivateKey: need('VALIDATOR_PRIVATE_KEY'),
  stakeToken: deployment.stakeToken,
  parentChainId: chain.parent.id as never,
  parentChainRpcUrl: process.env.PARENT_RPC_URL ?? chain.parent.rpcUrls.default.http[0]!,
  dasServerUrl: chain.anyTrust ? need('DAS_SERVER_URL') : undefined,
});

const dir = process.env.NODE_CONFIG_DIR ?? join(homedir(), '.sodi-chain', String(chain.chainId));
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = join(dir, 'node-config.json');
writeFileSync(file, `${JSON.stringify(nodeConfig, null, 2)}\n`, { mode: 0o600 });
console.log(`Wrote ${file} (contains private keys; keep it out of the repo)`);
