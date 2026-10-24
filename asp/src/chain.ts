import {
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { DepositRecord } from './screening.js';

export const depositedEvent = parseAbiItem(
  'event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)',
);

/** Events of the trusted forwarders that name the real depositor of a pool deposit. */
export const forwarderEvents = parseAbi([
  // SodiRecycler and SodiYieldDepositor (gasless recycles)
  'event Recycled(address indexed from, uint256 indexed commitment, uint256 deposited, uint256 fee, address feeRecipient)',
  // SodiYieldDepositor (ordinary deposits)
  'event Deposited(address indexed from, uint256 indexed commitment, uint256 assets, uint256 shares)',
]);

/**
 * Establishes who really funded a deposit.
 *
 * - Through a trusted forwarder (the recycler, the yield router): the address the forwarder names in its
 *   own event for this exact commitment, in the same transaction. No such event: `unresolved`.
 * - Any other depositor, ordinary account or contract (a Safe, say), is screened as itself.
 * - Except a contract that emits its own event about this deposit in the same transaction, naming
 *   someone else: that is what a forwarder does, and the approval service can't see for whom. It is
 *   `unknown-forwarder`, denied unless an operator allows it. A forwarder that emits nothing can't be
 *   told apart from a Safe; that limit is documented.
 */
export async function classifyDepositor(
  client: PublicClient,
  d: { depositor: string; commitment: string; txHash: string },
  forwarders: ReadonlySet<string>,
): Promise<{ kind: 'eoa' | 'contract' | 'forwarded' | 'unresolved' | 'unknown-forwarder'; depositor: string; via?: string }> {
  const seen = d.depositor.toLowerCase();
  if (forwarders.has(seen)) {
    const receipt = await client.getTransactionReceipt({ hash: d.txHash as Hex });
    const match = parseEventLogs({ abi: forwarderEvents, logs: receipt.logs }).find(
      (l) => l.address.toLowerCase() === seen && l.args.commitment === BigInt(d.commitment),
    );
    if (!match) return { kind: 'unresolved', depositor: seen, via: seen };
    return { kind: 'forwarded', depositor: match.args.from.toLowerCase(), via: seen };
  }
  const code = await client.getCode({ address: seen as Address });
  // EIP-7702 delegated accounts are ordinary accounts.
  if (!code || code === '0x' || code.toLowerCase().startsWith('0xef0100')) return { kind: 'eoa', depositor: seen };
  // A contract: does it emit its own event about this very deposit?
  const receipt = await client.getTransactionReceipt({ hash: d.txHash as Hex });
  const word = BigInt(d.commitment).toString(16).padStart(64, '0');
  const mentionsDeposit = receipt.logs.some(
    (l) => l.address.toLowerCase() === seen && (l.topics.some((t) => t?.toLowerCase().endsWith(word)) || l.data.toLowerCase().includes(word)),
  );
  return { kind: mentionsDeposit ? 'unknown-forwarder' : 'contract', depositor: seen };
}

export const entrypointAbi = parseAbi([
  'function latestRoot() view returns (uint256)',
  'function updateRoot(uint256 _root, string _ipfsCID) returns (uint256)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'error NoRootsAvailable()',
]);

export const ASP_POSTMAN_ROLE = keccak256(toHex('ASP_POSTMAN'));

export function makeChain(chainId: number, rpcUrl: string) {
  return defineChain({
    id: chainId,
    name: chainId === 4663 ? 'Robinhood Chain' : 'Robinhood Chain Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export function makeClients(chainId: number, rpcUrl: string, postmanKey?: Hex) {
  const chain = makeChain(chainId, rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = postmanKey
    ? createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(postmanKey) })
    : undefined;
  return { publicClient, walletClient };
}

/**
 * Fetches Deposited events in [fromBlock, toBlock] for the given pools, in chunks.
 * Halves the chunk size and retries when the RPC rejects a range as too large.
 */
export async function fetchDeposits(
  client: PublicClient,
  pools: Address[],
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: number,
): Promise<Omit<DepositRecord, 'timestamp' | 'status'>[]> {
  const out: Omit<DepositRecord, 'timestamp' | 'status'>[] = [];
  let start = fromBlock;
  let size = BigInt(Math.max(1, chunkSize));
  while (start <= toBlock) {
    const end = start + size - 1n > toBlock ? toBlock : start + size - 1n;
    try {
      const logs = await client.getLogs({ address: pools, event: depositedEvent, fromBlock: start, toBlock: end });
      for (const log of logs) {
        out.push({
          pool: log.address.toLowerCase(),
          label: log.args._label!.toString(),
          depositor: log.args._depositor!.toLowerCase(),
          value: log.args._value!.toString(),
          commitment: log.args._commitment!.toString(),
          blockNumber: Number(log.blockNumber),
          logIndex: log.logIndex!,
          txHash: log.transactionHash!,
        });
      }
      start = end + 1n;
    } catch (err) {
      if (size === 1n) throw err;
      size = size / 2n;
    }
  }
  return out;
}

/** Latest on-chain root, or 0 if none has ever been published. */
export async function latestRoot(client: PublicClient, entrypoint: Address): Promise<bigint> {
  try {
    return await client.readContract({ address: entrypoint, abi: entrypointAbi, functionName: 'latestRoot' });
  } catch (err) {
    if (String(err).includes('NoRootsAvailable')) return 0n;
    throw err;
  }
}
