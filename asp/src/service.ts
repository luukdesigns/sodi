import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Address, PublicClient, WalletClient } from 'viem';

import { ASP_POSTMAN_ROLE, entrypointAbi, fetchDeposits, latestRoot } from './chain.js';
import { type DepositRecord, type ScreeningPolicy, approvedLabels, screen } from './screening.js';
import { saveState, type ServiceState } from './state.js';
import { associationSetDocument, documentCid, encodeDocument } from './tree.js';

export interface ServiceContext {
  publicClient: PublicClient;
  walletClient?: WalletClient;
  entrypoint: Address;
  pools: Address[];
  policy: ScreeningPolicy;
  state: ServiceState;
  stateFile: string;
  setsDir: string;
  logChunkSize: number;
  dryRun: boolean;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface CycleResult {
  newDeposits: number;
  approved: number;
  pending: number;
  denied: number;
  root: bigint;
  onChainRoot: bigint;
  published?: { root: bigint; cid: string; txHash: string };
}

/**
 * One cycle: scan new deposits, screen every deposit, rebuild the approved-label tree and,
 * if its root differs from the one on-chain, publish it with `updateRoot`.
 *
 * Publishing a new root invalidates withdrawal proofs built against the old one (the pool only
 * accepts the latest root), so a root is published only when the approved set actually changes.
 */
export async function runCycle(ctx: ServiceContext): Promise<CycleResult> {
  const log = ctx.log ?? (() => {});
  const now = ctx.now ?? (() => Math.floor(Date.now() / 1000));
  const { state, publicClient } = ctx;

  // 1. Scan new deposits.
  const head = await publicClient.getBlockNumber();
  const from = BigInt(state.lastScannedBlock + 1);
  let newDeposits = 0;
  if (from <= head) {
    const found = await fetchDeposits(publicClient, ctx.pools, from, head, ctx.logChunkSize);
    const known = new Set(state.deposits.map((d) => `${d.pool}:${d.label}`));
    const timestamps = new Map<number, number>();
    for (const d of found) {
      if (known.has(`${d.pool}:${d.label}`)) continue;
      if (!timestamps.has(d.blockNumber)) {
        const block = await publicClient.getBlock({ blockNumber: BigInt(d.blockNumber) });
        timestamps.set(d.blockNumber, Number(block.timestamp));
      }
      state.deposits.push({ ...d, timestamp: timestamps.get(d.blockNumber)!, status: 'pending' });
      newDeposits++;
    }
    state.lastScannedBlock = Number(head);
  }

  // 2. Screen every deposit (re-screening lets block-list updates revoke past approvals).
  for (const d of state.deposits) {
    const before = d.status;
    Object.assign(d, screen(d, ctx.policy, now()));
    if (d.status !== before) log(`deposit ${shortLabel(d)} ${before} -> ${d.status}${d.reason ? ` (${d.reason})` : ''}`);
  }
  saveState(ctx.stateFile, state);

  // 3. Build the set and compare with on-chain.
  const labels = approvedLabels(state.deposits);
  const doc = associationSetDocument(state.chainId, ctx.entrypoint, labels);
  const root = BigInt(doc.root);
  const onChainRoot = await latestRoot(publicClient, ctx.entrypoint);
  const counts = countStatuses(state.deposits);
  const result: CycleResult = { newDeposits, ...counts, root, onChainRoot };

  if (labels.length === 0 || root === onChainRoot) return result;

  // 4. Publish.
  const cid = await documentCid(doc);
  mkdirSync(ctx.setsDir, { recursive: true });
  writeFileSync(join(ctx.setsDir, `${cid}.json`), encodeDocument(doc));

  if (ctx.dryRun || !ctx.walletClient) {
    log(`dry run: would publish root ${root} (${labels.length} labels, cid ${cid})`);
    return result;
  }

  const account = ctx.walletClient.account!;
  const isPostman = await publicClient.readContract({
    address: ctx.entrypoint,
    abi: entrypointAbi,
    functionName: 'hasRole',
    args: [ASP_POSTMAN_ROLE, account.address],
  });
  if (!isPostman) throw new Error(`${account.address} does not hold ASP_POSTMAN on ${ctx.entrypoint}`);

  const txHash = await ctx.walletClient.writeContract({
    address: ctx.entrypoint,
    abi: entrypointAbi,
    functionName: 'updateRoot',
    args: [root, cid],
    account,
    chain: ctx.walletClient.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`updateRoot reverted: ${txHash}`);

  state.published.push({ root: root.toString(), cid, labelCount: labels.length, txHash, publishedAt: now() });
  saveState(ctx.stateFile, state);
  log(`published root ${root} (${labels.length} labels, cid ${cid}) in ${txHash}`);
  return { ...result, published: { root, cid, txHash } };
}

function countStatuses(deposits: readonly DepositRecord[]) {
  let approved = 0;
  let pending = 0;
  let denied = 0;
  for (const d of deposits) {
    if (d.status === 'approved') approved++;
    else if (d.status === 'pending') pending++;
    else denied++;
  }
  return { approved, pending, denied };
}

function shortLabel(d: DepositRecord): string {
  return `${d.label.slice(0, 8)}… from ${d.depositor}`;
}
