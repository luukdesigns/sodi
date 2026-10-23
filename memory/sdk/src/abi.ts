import { parseAbi, parseAbiItem } from 'viem';

export const sodiMemoryAbi = parseAbi([
  'function commitInline(bytes32 namespace, uint64 expectedVersion, bytes envelope)',
  'function commitPointer(bytes32 namespace, uint64 expectedVersion, bytes32 contentHash, string location)',
  'function commitFor(address agent, bytes32 namespace, uint64 expectedVersion, bytes envelope, bytes32 contentHash, string location, uint256 deadline, bytes signature)',
  'function heads(address agent, bytes32 namespace) view returns (uint64 version, bytes32 contentHash)',
  'function nonces(address) view returns (uint256)',
  'error VersionConflict(uint64 current)',
  'error InvalidEnvelope()',
  'error MissingLocation()',
  'error BadSignature()',
  'error Expired()',
]);

export const memoryCommittedEvent = parseAbiItem(
  'event MemoryCommitted(address indexed agent, bytes32 indexed namespace, uint64 version, bytes32 contentHash, bytes envelope, string location)',
);
