import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { type Address, type Hex, createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { RelaySubmitter, loadPools } from './relay.js';
import { startServer } from './server.js';

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

async function main() {
  const key = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
  if (!key) throw new Error('RELAYER_PRIVATE_KEY is required');
  const rpcUrl = process.env.RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';
  const deploymentFile =
    process.env.DEPLOYMENT_FILE ?? resolve(import.meta.dirname, '../../contracts/deployments/46630.json');
  const deployment = JSON.parse(readFileSync(deploymentFile, 'utf8'));
  const relayFeeBPS = BigInt(process.env.RELAY_FEE_BPS ?? '0');
  const minWithdrawal = BigInt(process.env.MIN_WITHDRAWAL ?? '100000'); // 0.1 USDG
  const port = Number(process.env.PORT ?? 8403);

  const chain = defineChain({
    id: deployment.chainId,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ chain, account, transport: http(rpcUrl) });

  const entrypoint = deployment.contracts.Entrypoint as Address;
  const pools = Object.values(deployment.pools as Record<string, { pool: Address }>).map((p) => p.pool);
  const settings = {
    entrypoint,
    pools: await loadPools(publicClient, entrypoint, pools, relayFeeBPS),
    feeRecipient: (process.env.FEE_RECIPIENT as Address | undefined) ?? account.address,
    relayFeeBPS,
    minWithdrawal,
  };

  startServer(port, deployment.chainId, settings, new RelaySubmitter(publicClient, wallet, settings), log);
  const gas = await publicClient.getBalance({ address: account.address });
  log(`relayer ${account.address} on chain ${deployment.chainId}, fee ${relayFeeBPS} bps, gas balance ${gas} wei, listening on :${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
