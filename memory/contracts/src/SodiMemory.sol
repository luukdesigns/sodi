// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ECDSA} from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';
import {EIP712} from '@openzeppelin/contracts/utils/cryptography/EIP712.sol';
import {SignatureChecker} from '@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol';

/**
 * @title SodiMemory
 * @notice Encrypted, versioned memory for AI agents.
 *
 * Each agent owns named slots ("namespaces"). Every write commits the hash of an encrypted envelope
 * and bumps the slot's version. The envelope itself lives either inline in the event (small memory,
 * no other infrastructure) or in any blob store, with only its location recorded here. Because the
 * hash is on-chain, a blob store cannot alter or roll back what it serves.
 *
 * Writes are compare-and-swap on the version, so two running copies of the same agent cannot silently
 * overwrite each other. The contract never sees plaintext.
 */
contract SodiMemory is EIP712 {
  bytes2 public constant ENVELOPE_PREFIX = 0xA201;
  uint256 public constant MAX_INLINE = 16_384;

  bytes32 public constant COMMIT_TYPEHASH = keccak256(
    'Commit(address agent,bytes32 namespace,uint64 expectedVersion,bytes32 contentHash,bytes32 locationHash,uint256 nonce,uint256 deadline)'
  );

  struct Head {
    uint64 version;
    bytes32 contentHash;
  }

  mapping(address agent => mapping(bytes32 namespace => Head)) public heads;
  mapping(address agent => uint256) public nonces;

  /**
   * @param envelope  The encrypted envelope when stored inline; empty otherwise.
   * @param location  Where the envelope is stored (e.g. "ipfs://…") when not inline; empty otherwise.
   */
  event MemoryCommitted(
    address indexed agent,
    bytes32 indexed namespace,
    uint64 version,
    bytes32 contentHash,
    bytes envelope,
    string location
  );

  error VersionConflict(uint64 current);
  error InvalidEnvelope();
  error MissingLocation();
  error Expired();
  error BadSignature();

  constructor() EIP712('SodiMemory', '1') {}

  /// @notice Writes a new version, with the envelope stored inline.
  function commitInline(bytes32 namespace, uint64 expectedVersion, bytes calldata envelope) external {
    _commit(msg.sender, namespace, expectedVersion, envelope, keccak256(envelope), '');
  }

  /// @notice Writes a new version stored elsewhere; `contentHash` is keccak256 of the stored envelope.
  function commitPointer(bytes32 namespace, uint64 expectedVersion, bytes32 contentHash, string calldata location)
    external
  {
    _commit(msg.sender, namespace, expectedVersion, '', contentHash, location);
  }

  /**
   * @notice Gasless write authorized by the agent's EIP-712 signature. Pass either `envelope`
   * (inline) or `contentHash` + `location` (pointer).
   */
  function commitFor(
    address agent,
    bytes32 namespace,
    uint64 expectedVersion,
    bytes calldata envelope,
    bytes32 contentHash,
    string calldata location,
    uint256 deadline,
    bytes calldata signature
  ) external {
    if (block.timestamp > deadline) revert Expired();
    bytes32 hash = envelope.length > 0 ? keccak256(envelope) : contentHash;
    bytes32 structHash = keccak256(
      abi.encode(
        COMMIT_TYPEHASH, agent, namespace, expectedVersion, hash, keccak256(bytes(location)), nonces[agent], deadline
      )
    );
    if (!_isValidSignature(agent, _hashTypedDataV4(structHash), signature)) revert BadSignature();
    unchecked {
      nonces[agent]++;
    }
    _commit(agent, namespace, expectedVersion, envelope, hash, location);
  }

  function _commit(
    address agent,
    bytes32 namespace,
    uint64 expectedVersion,
    bytes memory envelope,
    bytes32 contentHash,
    string memory location
  ) private {
    Head storage head = heads[agent][namespace];
    if (head.version != expectedVersion) revert VersionConflict(head.version);

    if (envelope.length > 0) {
      if (envelope.length > MAX_INLINE || envelope.length < 2 || bytes2(_firstTwo(envelope)) != ENVELOPE_PREFIX) {
        revert InvalidEnvelope();
      }
      if (bytes(location).length > 0) revert InvalidEnvelope();
    } else if (bytes(location).length == 0) {
      revert MissingLocation();
    }

    head.version = expectedVersion + 1;
    head.contentHash = contentHash;
    emit MemoryCommitted(agent, namespace, head.version, contentHash, envelope, location);
  }

  function _firstTwo(bytes memory b) private pure returns (bytes2 out) {
    assembly {
      out := mload(add(b, 32))
    }
  }

  /// @dev Plain ECDSA first (works for EIP-7702 delegated EOAs), then ERC-1271.
  function _isValidSignature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
    (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
    if (err == ECDSA.RecoverError.NoError && recovered == signer) return true;
    return SignatureChecker.isValidERC1271SignatureNow(signer, digest, signature);
  }

  function domainSeparator() external view returns (bytes32) {
    return _domainSeparatorV4();
  }
}
