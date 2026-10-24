import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Address, Hex } from 'viem';

export interface Deployment {
  chainId: number;
  deploymentBlock: number;
  contracts: { Entrypoint: Address; SodiRecycler?: Address; SodiYieldDepositor?: Address };
  /** Contracts that deposit for others and name them in an event (recyclers, the yield router), current and superseded. */
  forwarders?: Address[];
  pools: Record<string, { asset: Address; pool: Address; scope: string }>;
}

export interface Config {
  rpcUrl: string;
  deployment: Deployment;
  postmanKey?: Hex;
  stateFile: string;
  setsDir: string;
  blocklistFile: string;
  vettingDelaySeconds: number;
  pollIntervalSeconds: number;
  logChunkSize: number;
  port: number;
  once: boolean;
  dryRun: boolean;
}

const here = (p: string) => resolve(import.meta.dirname, '..', p);

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const deploymentFile = process.env.DEPLOYMENT_FILE ?? here('../contracts/deployments/46630.json');
  const deployment = JSON.parse(readFileSync(deploymentFile, 'utf8')) as Deployment;
  const dryRun = argv.includes('--dry-run');

  const postmanKey = process.env.POSTMAN_PRIVATE_KEY as Hex | undefined;
  if (!dryRun && !postmanKey) {
    throw new Error('POSTMAN_PRIVATE_KEY is required (or run with --dry-run)');
  }

  return {
    rpcUrl: process.env.RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com',
    deployment,
    postmanKey,
    stateFile: process.env.STATE_FILE ?? here('data/state.json'),
    setsDir: process.env.SETS_DIR ?? here('data/sets'),
    blocklistFile: process.env.BLOCKLIST_FILE ?? here('blocklist.json'),
    // Default 30 minutes so an operator can deny a deposit before it is approved.
    vettingDelaySeconds: num('VETTING_DELAY_SECONDS', 1800),
    pollIntervalSeconds: num('POLL_INTERVAL_SECONDS', 15),
    logChunkSize: num('LOG_CHUNK_SIZE', 10_000),
    port: num('PORT', 8402),
    once: argv.includes('--once'),
    dryRun,
  };
}

export interface Blocklist {
  addresses: string[];
  labels: string[];
  /** Contracts allowed to deposit directly, e.g. known smart wallets. All other contracts are denied. */
  allowedContracts: string[];
}

export function loadBlocklist(path: string): Blocklist {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Blocklist>;
  return { addresses: parsed.addresses ?? [], labels: parsed.labels ?? [], allowedContracts: parsed.allowedContracts ?? [] };
}
