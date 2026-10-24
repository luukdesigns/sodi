// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

interface IERC3009Receive {
  function receiveWithAuthorization(
    address from,
    address to,
    uint256 value,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) external;
}

/// @title SodiRecycler
/// @notice Puts funds left at an address (an old rx402 session, a merchant's stealth address) back into
///         the privacy pool, without that address ever needing gas.
///
///         The address signs an EIP-3009 `ReceiveWithAuthorization` paying THIS contract, with a nonce
///         that commits to the pool precommitment of the new deposit and to the submitter's fee. Only
///         this contract can execute it, and only with that precommitment, so whoever submits the
///         transaction, the funds can only become the deposit the owner of the address chose.
///
///         The pool records this contract as the depositor, so it also forwards ragequits: the funds of
///         a ragequit go back to the address they came from, never anywhere else. It holds nothing
///         between calls and has no owner.
contract SodiRecycler is ReentrancyGuard {
  using SafeERC20 for IERC20;
  using ProofLib for ProofLib.RagequitProof;

  /// @notice Domain tag of the nonce commitment.
  bytes32 public constant NONCE_TAG = keccak256('sodi-recycle-v1');

  IEntrypoint public immutable entrypoint;
  IERC20 public immutable asset;

  /// @notice Where a ragequit of each recycled deposit sends the funds: the address they came from.
  mapping(uint256 commitment => address from) public refundTo;

  struct Authorization {
    address from;
    uint256 value;
    uint256 validAfter;
    uint256 validBefore;
    bytes32 nonce;
    uint8 v;
    bytes32 r;
    bytes32 s;
  }

  event Recycled(address indexed from, uint256 indexed commitment, uint256 deposited, uint256 fee, address feeRecipient);
  event Refunded(address indexed to, uint256 indexed commitment, uint256 value);

  error NonceMismatch();
  error FeeTooHigh();
  error UnknownCommitment();

  constructor(IEntrypoint entrypoint_, IERC20 asset_) {
    entrypoint = entrypoint_;
    asset = asset_;
  }

  /// @notice The nonce an address must sign to recycle into a deposit with `precommitment`.
  function recycleNonce(uint256 precommitment, uint256 fee, address feeRecipient) public pure returns (bytes32) {
    return keccak256(abi.encode(NONCE_TAG, precommitment, fee, feeRecipient));
  }

  /// @param a The EIP-3009 receive authorization (to = this contract) for the whole amount.
  /// @param precommitment The new deposit's precommitment, chosen by the owner of the funds.
  /// @param fee Paid to `feeRecipient` out of the amount, for submitting; the rest is deposited.
  function recycle(
    Authorization calldata a,
    uint256 precommitment,
    uint256 fee,
    address feeRecipient
  ) external nonReentrant returns (uint256 commitment) {
    if (a.nonce != recycleNonce(precommitment, fee, feeRecipient)) revert NonceMismatch();
    if (fee >= a.value) revert FeeTooHigh();

    IERC3009Receive(address(asset)).receiveWithAuthorization(
      a.from, address(this), a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s
    );
    if (fee > 0) asset.safeTransfer(feeRecipient, fee);
    uint256 amount = a.value - fee;
    asset.forceApprove(address(entrypoint), amount);
    commitment = entrypoint.deposit(asset, amount, precommitment);
    refundTo[commitment] = a.from;
    emit Recycled(a.from, commitment, amount, fee, feeRecipient);
  }

  /// @notice Ragequits a recycled deposit and sends the funds back to the address they came from.
  ///         Anyone may submit it: the proof needs the deposit's secrets, and the destination is fixed.
  function ragequit(ProofLib.RagequitProof calldata proof) external nonReentrant {
    uint256 commitment = proof.pubSignals[0];
    address to = refundTo[commitment];
    if (to == address(0)) revert UnknownCommitment();
    delete refundTo[commitment];

    (IPrivacyPool pool,,,) = entrypoint.assetConfig(asset);
    uint256 before = asset.balanceOf(address(this));
    pool.ragequit(proof);
    uint256 received = asset.balanceOf(address(this)) - before;
    asset.safeTransfer(to, received);
    emit Refunded(to, commitment, received);
  }
}
