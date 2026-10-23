// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from '@oz/utils/cryptography/ECDSA.sol';
import {EIP712} from '@oz/utils/cryptography/EIP712.sol';
import {SignatureChecker} from '@oz/utils/cryptography/SignatureChecker.sol';

/**
 * @title SodiA2A
 * @notice Encrypted agent-to-agent messaging on a public chain.
 *
 * The contract never sees plaintext. Agents encrypt off-chain to the X25519 keys other agents publish
 * here, and post only the resulting envelopes. Envelopes do not name their recipients: each agent tries
 * to open every envelope on the channels it follows, and only the intended ones succeed.
 *
 * Channels control who may *write*: channel 0 is open to everyone; other channels can be restricted to a
 * whitelist of writers. Who may *read* is decided by encryption alone.
 *
 * Agents with no gas can authorize posts and key registrations with an EIP-712 signature, which anyone
 * (a relayer) can submit. EOAs and ERC-1271 smart accounts are both supported.
 */
contract SodiA2A is EIP712 {
  /// @notice Envelope header: magic byte 0xA2 followed by the protocol version.
  bytes2 public constant ENVELOPE_PREFIX = 0xA201;
  /// @notice Smallest possible envelope: prefix, ephemeral key, recipient count, one wrapped key, nonce, tag.
  uint256 public constant MIN_ENVELOPE = 2 + 32 + 2 + 48 + 24 + 16;
  uint256 public constant MAX_ENVELOPE = 16_384;

  bytes32 public constant POST_TYPEHASH =
    keccak256('Post(address author,uint256 channelId,bytes32 envelopeHash,uint256 nonce,uint256 deadline)');
  bytes32 public constant SET_KEY_TYPEHASH =
    keccak256('SetKey(address agent,bytes32 encryptionKey,uint256 nonce,uint256 deadline)');

  struct Channel {
    address owner;
    bool restricted;
  }

  /// @notice Each agent's X25519 public key.
  mapping(address agent => bytes32 key) public encryptionKey;
  /// @notice Replay protection for signed actions.
  mapping(address agent => uint256 nonce) public nonces;

  mapping(uint256 channelId => Channel) public channels;
  mapping(uint256 channelId => mapping(address writer => bool allowed)) public isWriter;
  uint256 public channelCount = 1; // channel 0 is the open inbox

  event KeySet(address indexed agent, bytes32 encryptionKey);
  event ChannelCreated(uint256 indexed channelId, address indexed owner, bool restricted);
  event WriterSet(uint256 indexed channelId, address indexed writer, bool allowed);
  event Posted(uint256 indexed channelId, address indexed author, bytes envelope);

  error InvalidKey();
  error InvalidEnvelope();
  error UnknownChannel();
  error NotChannelOwner();
  error NotAWriter();
  error Expired();
  error BadSignature();

  constructor() EIP712('SodiA2A', '1') {}

  // ------------------------------------------------------------------ keys

  function setKey(bytes32 key) external {
    _setKey(msg.sender, key);
  }

  function setKeyFor(address agent, bytes32 key, uint256 deadline, bytes calldata signature) external {
    bytes32 structHash = keccak256(abi.encode(SET_KEY_TYPEHASH, agent, key, nonces[agent], deadline));
    _consumeSignature(agent, structHash, deadline, signature);
    _setKey(agent, key);
  }

  function _setKey(address agent, bytes32 key) private {
    if (key == bytes32(0)) revert InvalidKey();
    encryptionKey[agent] = key;
    emit KeySet(agent, key);
  }

  // ------------------------------------------------------------------ channels

  function createChannel(bool restricted, address[] calldata writers) external returns (uint256 channelId) {
    channelId = channelCount++;
    channels[channelId] = Channel({owner: msg.sender, restricted: restricted});
    emit ChannelCreated(channelId, msg.sender, restricted);
    for (uint256 i; i < writers.length; ++i) {
      isWriter[channelId][writers[i]] = true;
      emit WriterSet(channelId, writers[i], true);
    }
  }

  function setWriter(uint256 channelId, address writer, bool allowed) external {
    if (channelId == 0 || channels[channelId].owner == address(0)) revert UnknownChannel();
    if (channels[channelId].owner != msg.sender) revert NotChannelOwner();
    isWriter[channelId][writer] = allowed;
    emit WriterSet(channelId, writer, allowed);
  }

  function canPost(uint256 channelId, address author) public view returns (bool) {
    if (channelId == 0) return true;
    Channel storage c = channels[channelId];
    if (c.owner == address(0)) return false;
    return !c.restricted || c.owner == author || isWriter[channelId][author];
  }

  // ------------------------------------------------------------------ posting

  function post(uint256 channelId, bytes calldata envelope) external {
    _post(msg.sender, channelId, envelope);
  }

  function postFor(
    address author,
    uint256 channelId,
    bytes calldata envelope,
    uint256 deadline,
    bytes calldata signature
  ) external {
    bytes32 structHash =
      keccak256(abi.encode(POST_TYPEHASH, author, channelId, keccak256(envelope), nonces[author], deadline));
    _consumeSignature(author, structHash, deadline, signature);
    _post(author, channelId, envelope);
  }

  function _post(address author, uint256 channelId, bytes calldata envelope) private {
    if (channelId != 0 && channels[channelId].owner == address(0)) revert UnknownChannel();
    if (!canPost(channelId, author)) revert NotAWriter();
    // The contract cannot prove an envelope is encrypted, but it refuses anything without the envelope
    // header or outside the size bounds, so plaintext is not accepted by accident.
    if (envelope.length < MIN_ENVELOPE || envelope.length > MAX_ENVELOPE || bytes2(envelope[:2]) != ENVELOPE_PREFIX) {
      revert InvalidEnvelope();
    }
    emit Posted(channelId, author, envelope);
  }

  // ------------------------------------------------------------------ signatures

  function _consumeSignature(address signer, bytes32 structHash, uint256 deadline, bytes calldata signature) private {
    if (block.timestamp > deadline) revert Expired();
    if (!_isValidSignature(signer, _hashTypedDataV4(structHash), signature)) revert BadSignature();
    unchecked {
      nonces[signer]++;
    }
  }

  /**
   * @dev Accepts a plain ECDSA signature from `signer` even when `signer` has code, then falls back to
   * ERC-1271. OpenZeppelin's `isValidSignatureNow` only tries ERC-1271 for addresses with code, which
   * rejects EIP-7702 delegated EOAs whose delegate does not implement it.
   */
  function _isValidSignature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
    (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
    if (err == ECDSA.RecoverError.NoError && recovered == signer) return true;
    return SignatureChecker.isValidERC1271SignatureNow(signer, digest, signature);
  }

  function domainSeparator() external view returns (bytes32) {
    return _domainSeparatorV4();
  }
}
