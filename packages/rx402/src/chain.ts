import { type Address, type Hex, type PublicClient, parseAbi, parseAbiItem, parseEventLogs } from 'viem';

export const entrypointAbi = parseAbi([
  'function deposit(address _asset, uint256 _value, uint256 _precommitment) returns (uint256)',
  'function relay((address processooor, bytes data) _withdrawal, (uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[8] pubSignals) _proof, uint256 _scope)',
  'function latestRoot() view returns (uint256)',
  'function assetConfig(address) view returns (address pool, uint256 minimumDepositAmount, uint256 vettingFeeBPS, uint256 maxRelayFeeBPS)',
  'error NoRootsAvailable()',
]);

export const poolAbi = parseAbi([
  'function SCOPE() view returns (uint256)',
  'function ASSET() view returns (address)',
  'function currentRoot() view returns (uint256)',
  'function nullifierHashes(uint256) view returns (bool)',
]);

export const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

export const depositedEvent = parseAbiItem(
  'event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)',
);
export const withdrawnEvent = parseAbiItem(
  'event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)',
);

interface LeafEvent {
  commitment: bigint;
  blockNumber: bigint;
  logIndex: number;
}

/**
 * All commitments in the pool's state tree, in insertion order. Deposits insert their commitment
 * and withdrawals insert the change commitment; ragequits insert nothing.
 */
export async function stateTreeLeaves(
  client: PublicClient,
  pool: Address,
  fromBlock: bigint,
  chunkSize = 10_000n,
): Promise<bigint[]> {
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const leaves: LeafEvent[] = [];
  for (let start = fromBlock; start <= head; start += chunkSize) {
    const end = start + chunkSize - 1n > head ? head : start + chunkSize - 1n;
    const [deposits, withdrawals] = await Promise.all([
      client.getLogs({ address: pool, event: depositedEvent, fromBlock: start, toBlock: end }),
      client.getLogs({ address: pool, event: withdrawnEvent, fromBlock: start, toBlock: end }),
    ]);
    for (const l of deposits) {
      leaves.push({ commitment: l.args._commitment!, blockNumber: l.blockNumber, logIndex: l.logIndex });
    }
    for (const l of withdrawals) {
      leaves.push({ commitment: l.args._newCommitment!, blockNumber: l.blockNumber, logIndex: l.logIndex });
    }
  }
  return leaves
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
    .map((l) => l.commitment);
}

export async function latestAspRoot(client: PublicClient, entrypoint: Address): Promise<bigint> {
  try {
    return await client.readContract({ address: entrypoint, abi: entrypointAbi, functionName: 'latestRoot' });
  } catch (err) {
    if (String(err).includes('NoRootsAvailable')) return 0n;
    throw err;
  }
}

export type { Hex };

const withdrawalRelayedEvent = parseAbiItem(
  'event WithdrawalRelayed(address indexed _relayer, address indexed _recipient, address indexed _asset, uint256 _amount, uint256 _feeAmount)',
);

export interface FoundWithdrawal {
  value: bigint;
  newCommitment: bigint;
  txHash: Hex;
  /** The session address funded, and what it received after the relay fee (if relayed). */
  recipient?: Address;
  received?: bigint;
}

/** Finds the withdrawal that spent `spentNullifierHash`, scanning from `fromBlock`. */
export async function findWithdrawal(
  client: PublicClient,
  pool: Address,
  entrypoint: Address,
  fromBlock: bigint,
  spentNullifierHash: bigint,
  chunkSize = 10_000n,
): Promise<FoundWithdrawal | undefined> {
  const head = await client.getBlockNumber({ cacheTime: 0 });
  // Newest first: the spend we are looking for is almost always recent.
  for (let end = head; end >= fromBlock; end -= chunkSize) {
    const start = end - chunkSize + 1n > fromBlock ? end - chunkSize + 1n : fromBlock;
    const logs = await client.getLogs({ address: pool, event: withdrawnEvent, fromBlock: start, toBlock: end });
    const hit = logs.find((l) => l.args._spentNullifier === spentNullifierHash);
    if (!hit) {
      if (start === fromBlock) break;
      continue;
    }
    const receipt = await client.getTransactionReceipt({ hash: hit.transactionHash });
    const relayed = parseEventLogs({ abi: [withdrawalRelayedEvent], logs: receipt.logs }).find(
      (l) => l.address.toLowerCase() === entrypoint.toLowerCase(),
    );
    return {
      value: hit.args._value!,
      newCommitment: hit.args._newCommitment!,
      txHash: hit.transactionHash,
      recipient: relayed?.args._recipient,
      received: relayed ? relayed.args._amount! - relayed.args._feeAmount! : undefined,
    };
  }
  return undefined;
}

/** Finds the deposit with `precommitment`, for recovering a deposit whose note was never saved. */
export async function findDeposit(
  client: PublicClient,
  pool: Address,
  fromBlock: bigint,
  precommitment: bigint,
  chunkSize = 10_000n,
): Promise<{ label: bigint; value: bigint; commitment: bigint; txHash: Hex } | undefined> {
  const head = await client.getBlockNumber({ cacheTime: 0 });
  for (let end = head; end >= fromBlock; end -= chunkSize) {
    const start = end - chunkSize + 1n > fromBlock ? end - chunkSize + 1n : fromBlock;
    const logs = await client.getLogs({ address: pool, event: depositedEvent, fromBlock: start, toBlock: end });
    const hit = logs.find((l) => l.args._precommitmentHash === precommitment);
    if (hit) return { label: hit.args._label!, value: hit.args._value!, commitment: hit.args._commitment!, txHash: hit.transactionHash };
    if (start === fromBlock) break;
  }
  return undefined;
}
