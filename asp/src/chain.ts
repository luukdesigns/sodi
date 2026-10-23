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
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { DepositRecord } from './screening.js';

export const depositedEvent = parseAbiItem(
  'event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)',
);

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
