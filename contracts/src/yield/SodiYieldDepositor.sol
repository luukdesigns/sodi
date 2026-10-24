// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';

import {Constants} from 'contracts/lib/Constants.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';
import {IState} from 'interfaces/IState.sol';

import {SodiYieldVault} from './SodiYieldVault.sol';

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

/// @title SodiYieldDepositor (prototype)
/// @notice The only way into the yield pool: takes USDG, mints yield-vault shares and deposits them
///         into the pool, in one transaction.
///
///         - `deposit`: from a wallet that approved this contract.
///         - `recycle`: gasless, from an EIP-3009 `ReceiveWithAuthorization` whose nonce commits to the
///           precommitment and the submitter's fee. Same interface and nonce as SodiRecycler, so the
///           rx402 SDK recycles into the yield pool unchanged.
///
///         The pool records this contract as the depositor, so it forwards ragequits: the shares are
///         redeemed and the USDG goes back to the address that deposited, never anywhere else.
///
///         PROTOTYPE: not audited, not deployed. See docs/yield-pool-design.md.
contract SodiYieldDepositor is ReentrancyGuard {
  using SafeERC20 for IERC20;
  using ProofLib for ProofLib.RagequitProof;

  bytes32 public constant NONCE_TAG = keccak256('sodi-recycle-v1');

  IEntrypoint public immutable entrypoint;
  SodiYieldVault public immutable vault;
  IERC20 public immutable usdg;

  /// @notice Where a ragequit of each deposit sends its USDG: the address that deposited. Keyed by the
  ///         deposit's label, which stays the same when part of it is withdrawn and the commitment changes.
  mapping(uint256 label => address from) public refundTo;

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

  event Deposited(address indexed from, uint256 indexed commitment, uint256 assets, uint256 shares);
  event Recycled(address indexed from, uint256 indexed commitment, uint256 deposited, uint256 fee, address feeRecipient);
  event Refunded(address indexed to, uint256 indexed commitment, uint256 shares, uint256 assets);

  error NonceMismatch();
  error FeeTooHigh();
  error UnknownLabel();

  constructor(IEntrypoint entrypoint_, SodiYieldVault vault_) {
    entrypoint = entrypoint_;
    vault = vault_;
    usdg = IERC20(vault_.asset());
  }

  /// @notice The pool's asset, for SodiRecycler compatibility (`recycleMinimum` reads it).
  function asset() external view returns (address) {
    return address(vault);
  }

  function deposit(uint256 assets, uint256 precommitment) external nonReentrant returns (uint256 commitment) {
    usdg.safeTransferFrom(msg.sender, address(this), assets);
    uint256 shares;
    (commitment, shares) = _wrapAndDeposit(msg.sender, assets, precommitment);
    emit Deposited(msg.sender, commitment, assets, shares);
  }

  function recycleNonce(uint256 precommitment, uint256 fee, address feeRecipient) public pure returns (bytes32) {
    return keccak256(abi.encode(NONCE_TAG, precommitment, fee, feeRecipient));
  }

  function recycle(Authorization calldata a, uint256 precommitment, uint256 fee, address feeRecipient)
    external
    nonReentrant
    returns (uint256 commitment)
  {
    if (a.nonce != recycleNonce(precommitment, fee, feeRecipient)) revert NonceMismatch();
    if (fee >= a.value) revert FeeTooHigh();
    IERC3009Receive(address(usdg)).receiveWithAuthorization(a.from, address(this), a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
    if (fee > 0) usdg.safeTransfer(feeRecipient, fee);
    (commitment,) = _wrapAndDeposit(a.from, a.value - fee, precommitment);
    emit Recycled(a.from, commitment, a.value - fee, fee, feeRecipient);
  }

  function _wrapAndDeposit(address from, uint256 assets, uint256 precommitment) internal returns (uint256 commitment, uint256 shares) {
    usdg.forceApprove(address(vault), assets);
    shares = vault.deposit(assets, address(this));
    IERC20(address(vault)).forceApprove(address(entrypoint), shares);
    commitment = entrypoint.deposit(IERC20(address(vault)), shares, precommitment);
    (IPrivacyPool pool,,,) = entrypoint.assetConfig(IERC20(address(vault)));
    // The label the pool just gave the deposit, computed exactly as the pool does.
    uint256 label = uint256(keccak256(abi.encodePacked(pool.SCOPE(), IState(address(pool)).nonce()))) % Constants.SNARK_SCALAR_FIELD;
    refundTo[label] = from;
  }

  /// @notice Ragequits a deposit made through this contract (or what's left of it) and sends its USDG
  ///         back to the depositor. Anyone may submit it: the proof needs the deposit's secrets, and the
  ///         destination is fixed.
  function ragequit(ProofLib.RagequitProof calldata proof) external nonReentrant {
    uint256 commitment = proof.pubSignals[0];
    uint256 label = proof.pubSignals[3];
    address to = refundTo[label];
    if (to == address(0)) revert UnknownLabel();
    delete refundTo[label];
    (IPrivacyPool pool,,,) = entrypoint.assetConfig(IERC20(address(vault)));
    uint256 before = IERC20(address(vault)).balanceOf(address(this));
    pool.ragequit(proof);
    uint256 shares = IERC20(address(vault)).balanceOf(address(this)) - before;
    uint256 assets = vault.redeem(shares, to, address(this));
    emit Refunded(to, commitment, shares, assets);
  }
}
