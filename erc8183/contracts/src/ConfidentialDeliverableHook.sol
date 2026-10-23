// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC165} from '@openzeppelin/contracts/utils/introspection/IERC165.sol';

import {IACPHook} from './reference/IACPHook.sol';

/// @notice Anything that maps an address to its X25519 messaging key, e.g. a deployed SodiA2A contract.
interface IKeyRegistry {
  function encryptionKey(address agent) external view returns (bytes32);
}

/**
 * @title ConfidentialDeliverableHook
 * @notice ERC-8183 hook that keeps a job's deliverable confidential while the job stays public.
 *
 * The provider encrypts the work to the client and the evaluator off-chain and submits:
 *   - `deliverable` = keccak256(envelope)   (public, verifiable commitment, as the standard expects)
 *   - `optParams`   = envelope              (ciphertext only)
 *
 * The hook refuses the submission unless the envelope is well-formed and matches the committed hash,
 * and unless the client and evaluator have published keys to encrypt to. It then emits the envelope
 * so the client and evaluator can fetch and open it. Everyone else sees the job, its state transitions,
 * payments and the commitment, but never the work.
 *
 * The evaluator can optionally do the same for `complete`/`reject`, keeping its reasoning confidential
 * while committing to it in the public `reason` field.
 *
 * Built against the ERC-8183 reference `AgenticCommerce`, where hook data is
 * `abi.encode(msg.sender, <args>..., optParams)`. No changes to the core contract are needed.
 */
contract ConfidentialDeliverableHook is IACPHook {
  bytes4 public constant CREATE_JOB = bytes4(keccak256('createJob(address,address,uint256,string,address)'));
  bytes4 public constant SUBMIT = bytes4(keccak256('submit(uint256,bytes32,bytes)'));
  bytes4 public constant COMPLETE = bytes4(keccak256('complete(uint256,bytes32,bytes)'));
  bytes4 public constant REJECT = bytes4(keccak256('reject(uint256,bytes32,bytes)'));

  /// @notice Envelope header (Sodi envelope format, version 1) and size bounds.
  bytes2 public constant ENVELOPE_PREFIX = 0xA201;
  uint256 public constant MIN_ENVELOPE = 2 + 32 + 2 + 48 + 24 + 16;
  uint256 public constant MAX_ENVELOPE = 16_384;

  address public immutable commerce;
  IKeyRegistry public immutable keys;

  struct Parties {
    address client;
    address evaluator;
  }

  mapping(uint256 jobId => Parties) public parties;

  event ConfidentialDeliverable(uint256 indexed jobId, address indexed provider, bytes32 deliverable, bytes envelope);
  event ConfidentialReason(
    uint256 indexed jobId, address indexed evaluator, bytes4 indexed action, bytes32 reason, bytes envelope
  );

  error OnlyCommerce();
  error UnknownJob();
  error MissingEnvelope();
  error InvalidEnvelope();
  error CommitmentMismatch();
  error MissingRecipientKey(address party);

  constructor(address commerce_, IKeyRegistry keys_) {
    commerce = commerce_;
    keys = keys_;
  }

  modifier onlyCommerce() {
    if (msg.sender != commerce) revert OnlyCommerce();
    _;
  }

  function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external view onlyCommerce {
    if (selector == SUBMIT) {
      (, bytes32 deliverable, bytes memory envelope) = abi.decode(data, (address, bytes32, bytes));
      Parties memory p = parties[jobId];
      if (p.client == address(0)) revert UnknownJob();
      if (envelope.length == 0) revert MissingEnvelope();
      _checkEnvelope(envelope, deliverable);
      // The provider can only encrypt to parties that have published a key.
      if (keys.encryptionKey(p.client) == bytes32(0)) revert MissingRecipientKey(p.client);
      if (keys.encryptionKey(p.evaluator) == bytes32(0)) revert MissingRecipientKey(p.evaluator);
    } else if (selector == COMPLETE || selector == REJECT) {
      (, bytes32 reason, bytes memory envelope) = abi.decode(data, (address, bytes32, bytes));
      // Confidential reasons are optional: an empty optParams keeps the standard behaviour.
      if (envelope.length > 0) _checkEnvelope(envelope, reason);
    }
  }

  function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyCommerce {
    if (selector == CREATE_JOB) {
      (address client,, address evaluator) = abi.decode(data, (address, address, address));
      parties[jobId] = Parties({client: client, evaluator: evaluator});
    } else if (selector == SUBMIT) {
      (address provider, bytes32 deliverable, bytes memory envelope) = abi.decode(data, (address, bytes32, bytes));
      emit ConfidentialDeliverable(jobId, provider, deliverable, envelope);
    } else if (selector == COMPLETE || selector == REJECT) {
      (address actor, bytes32 reason, bytes memory envelope) = abi.decode(data, (address, bytes32, bytes));
      if (envelope.length > 0) emit ConfidentialReason(jobId, actor, selector, reason, envelope);
    }
  }

  function _checkEnvelope(bytes memory envelope, bytes32 commitment) private pure {
    if (envelope.length < MIN_ENVELOPE || envelope.length > MAX_ENVELOPE) revert InvalidEnvelope();
    if (envelope[0] != 0xA2 || envelope[1] != 0x01) revert InvalidEnvelope();
    if (keccak256(envelope) != commitment) revert CommitmentMismatch();
  }

  function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
    return interfaceId == type(IACPHook).interfaceId || interfaceId == type(IERC165).interfaceId;
  }
}
