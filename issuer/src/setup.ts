import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { FileStore, HttpRelayer, PoolWallet, WithdrawalProver, aspAssociationSet } from '@sodi/rx402';
import { type Address, type Hex, createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`${name} is required`);
  return v;
};

/** The pool wallet and chain clients, from the environment (see README). */
export async function poolFromEnv(opts: { withRelayer: boolean }) {
  const rpcUrl = env('RPC_URL', 'https://rpc.testnet.chain.robinhood.com');
  const deployment = JSON.parse(readFileSync(env('DEPLOYMENT_FILE', resolve(import.meta.dirname, '../../contracts/deployments/46630.json')), 'utf8'));
  const chain = defineChain({
    id: deployment.chainId,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const ownerKey = process.env.OWNER_PRIVATE_KEY as Hex | undefined;
  const entrypoint = deployment.contracts.Entrypoint as Address;
  const storePath = env('ISSUER_STORE', join(homedir(), '.sodi', 'issuer.json'));
  const store = new FileStore(storePath);
  const wallet = new PoolWallet({
    publicClient,
    ownerWallet: ownerKey ? createWalletClient({ chain, account: privateKeyToAccount(ownerKey), transport: http(rpcUrl) }) : undefined,
    mnemonic: env('RX402_MNEMONIC'),
    entrypoint,
    pool: deployment.pools.USDG.pool as Address,
    asset: deployment.pools.USDG.asset as Address,
    poolDeploymentBlock: BigInt(deployment.deploymentBlock),
    relayer: opts.withRelayer
      ? await HttpRelayer.connect(env('RELAYER_URL', 'http://localhost:8403'), {
          chainId: deployment.chainId as number,
          entrypoint,
          feeRecipient: process.env.RELAYER_FEE_RECIPIENT as Address | undefined,
          maxFeeBPS: BigInt(env('RELAYER_MAX_FEE_BPS', '100')),
        })
      : { feeRecipient: entrypoint, relayFeeBPS: 0n, relay: () => Promise.reject(new Error('no relayer')) },
    prover: new WithdrawalProver(),
    associationSet: aspAssociationSet(env('ASP_URL', 'http://localhost:8402')),
    store,
  });
  return { wallet, store, storePath, chainId: deployment.chainId as number, publicClient };
}

/**
 * The issuer and the deposit command both write the pool store, so only one may run at a time.
 * Returns a release function, or throws if another live process holds the lock.
 */
export function lockStore(storePath: string): () => void {
  const lock = `${storePath}.lock`;
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = pid !== process.pid;
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`${storePath} is in use by process ${pid} (the issuer?); stop it first`);
  }
  writeFileSync(lock, String(process.pid), { mode: 0o600 });
  return () => rmSync(lock, { force: true });
}
