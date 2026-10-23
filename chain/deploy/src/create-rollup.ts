/**
 * Deploys the Sodi L3's core contracts (rollup, bridge, inbox, sequencer inbox) on Robinhood Chain.
 *
 *   npm run rollup            dry run: builds the transaction, simulates it, prints the cost
 *   npm run rollup -- --send  sends it and writes chain/deployments/<chainId>.json
 *
 * Environment:
 *   DEPLOYER_PRIVATE_KEY   becomes the rollup owner and initial chain owner
 *   BATCH_POSTER_ADDRESS   the key the sequencer uses to post batches to Robinhood Chain
 *   VALIDATOR_ADDRESS      the key that posts assertions (comma-separated for several)
 *   SODI_NETWORK           testnet (default) or mainnet
 *   PARENT_RPC_URL         optional; defaults to the public Robinhood Chain RPC
 *
 * Use three different keys. The owner can upgrade everything, so on mainnet it belongs in a multisig.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRollup, createRollupGetRetryablesFeesWithDefaults, createRollupPrepareTransactionRequest } from '@arbitrum/chain-sdk';
import { type Address, type Hex, createPublicClient, formatEther, getAddress, http, parseEther, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { PARENT_FACTORIES, SODI_CHAINS, network, rollupConfig } from './config.js';

const need = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`set ${n}`);
  return v;
};

const send = process.argv.includes('--send');
const net = network();
const chain = SODI_CHAINS[net];
const rpcUrl = process.env.PARENT_RPC_URL ?? chain.parent.rpcUrls.default.http[0]!;
const parentClient = createPublicClient({ chain: chain.parent, transport: http(rpcUrl) });

const actualParent = await parentClient.getChainId();
if (actualParent !== chain.parent.id) throw new Error(`RPC is chain ${actualParent}, expected ${chain.parent.id}`);

const owner = privateKeyToAccount(need('DEPLOYER_PRIVATE_KEY') as Hex);
const batchPoster = getAddress(need('BATCH_POSTER_ADDRESS'));
const validators = need('VALIDATOR_ADDRESS').split(',').map((a) => getAddress(a.trim()));
if (validators.includes(owner.address) || batchPoster === owner.address) {
  console.warn('warning: reuse of the owner key as batch poster or validator; fine for a fork, not for a real deployment');
}

const config = rollupConfig(parentClient as never, chain, owner.address);
const params = { config, batchPosters: [batchPoster], validators };

console.log(`${chain.name} (chain ${chain.chainId}) on ${chain.parent.name} (${chain.parent.id})`);
console.log(`  owner         ${owner.address}`);
console.log(`  batch poster  ${batchPoster}`);
console.log(`  validators    ${validators.join(', ')}`);
console.log(`  data          ${chain.anyTrust ? 'AnyTrust (committee)' : 'rollup (all data on Robinhood Chain)'}`);
console.log(`  challenge     ${config.confirmPeriodBlocks} L1 blocks; stake ${formatEther(config.baseStake)} WETH`);
console.log(`  RollupCreator ${PARENT_FACTORIES[chain.parent.id as 46630 | 4663].rollupCreator}`);

if (!send) {
  // The call value prepays the retryable tickets that deploy the token bridge factories on the L3.
  // Any unused part is refunded on the L3, so it is not lost, but it must be in the wallet up front.
  const value = await createRollupGetRetryablesFeesWithDefaults(parentClient as never, {
    account: owner.address,
    nativeToken: zeroAddress,
  });
  const balance = await parentClient.getBalance({ address: owner.address });
  console.log('\nDry run');
  console.log(`  value         ${formatEther(value)} ETH (prepaid L3 factory deployment, refunded on the L3 if unused)`);
  console.log(`  balance       ${formatEther(balance)} ETH`);
  if (balance <= value) {
    console.log(`  not enough to simulate on-chain; fund the owner with ~${formatEther(value + parseEther('0.01'))} ETH,`);
    console.log('  or run test/run-fork.sh to rehearse the whole deployment on a fork.');
    process.exit(0);
  }
  const request = await createRollupPrepareTransactionRequest({
    params,
    account: owner.address,
    publicClient: parentClient as never,
  });
  const gasPrice = await parentClient.getGasPrice();
  const gas = request.gas ?? 0n;
  console.log(`  gas           ${gas} (~${formatEther(gas * gasPrice)} ETH at ${gasPrice} wei/gas)`);
  console.log('\nSimulation passed. Re-run with --send to deploy.');
  process.exit(0);
}

const { transactionReceipt, coreContracts } = await createRollup({
  params,
  account: owner,
  parentChainPublicClient: parentClient as never,
});

const out = {
  network: net,
  chainId: chain.chainId,
  name: chain.name,
  parentChainId: chain.parent.id,
  owner: owner.address,
  batchPosters: [batchPoster],
  validators,
  anyTrust: chain.anyTrust,
  stakeToken: config.stakeToken,
  deploymentTx: transactionReceipt.transactionHash,
  deploymentBlock: Number(transactionReceipt.blockNumber),
  chainConfig: JSON.parse(config.chainConfig),
  coreContracts,
};
const file = process.env.DEPLOYMENT_OUT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deployments', `${chain.chainId}.json`);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);

console.log(`\nDeployed in ${transactionReceipt.transactionHash} (block ${transactionReceipt.blockNumber})`);
for (const [k, v] of Object.entries(coreContracts)) console.log(`  ${k.padEnd(22)} ${v as Address}`);
console.log(`\nWrote ${file}. Next: npm run node-config, start the node, then npm run token-bridge.`);
