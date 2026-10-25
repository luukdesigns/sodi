// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {SodiYieldVault} from './SodiYieldVault.sol';

/// @title SodiSessionFunder (prototype)
/// @notice Turns a zero-knowledge withdrawal of yield-vault shares into a USDG session, in one
///         transaction.
///
///         It is the withdrawal's processooor: the proof commits to this contract and to the funding data
///         (session, relayer fee recipient, relayer fee, exact USDG for the session), so whoever submits
///         it, usually a relayer, can't change any of them. The pool checks the proof and the latest
///         approval root and sends the shares here. This contract redeems them and pays the session
///         **exactly** the amount the proof states, plus the relayer fee and the protocol fee on it.
///
///         The share price moves between proving and landing, so the prover withdraws a small margin of
///         extra shares. Whatever the margin leaves over goes to the depositors with the protocol fee
///         (donated to the yield vault, where it streams into the share price over seven days). If the
///         shares are worth less than the session plus fees (a loss in the underlying vault, say), it
///         reverts rather than pay short.
///
///         A session-open fee can be turned on once, by the deployer (`setFeeSink`): a fixed share of
///         each session, paid in USDG to a fee sink. Until then there is none.
///
///         PROTOTYPE: not audited, not deployed. See docs/yield-pool-design.md.
contract SodiSessionFunder is ReentrancyGuard {
  using SafeERC20 for IERC20;

  struct FundingData {
    address session;
    address feeRecipient;
    uint256 relayFeeBPS;
    /// @notice Exactly what the session receives, in USDG base units.
    uint256 amount;
  }

  IPrivacyPool public immutable pool;
  SodiYieldVault public immutable vault;
  IERC20 public immutable usdg;
  /// @notice Charged on each session's amount and donated to the yield vault, in basis points.
  uint256 public immutable protocolFeeBPS;
  uint256 public constant MAX_RELAY_FEE_BPS = 100;
  uint256 public constant MAX_SESSION_FEE_BPS = 100;

  /// @notice Can set the fee sink, once.
  address public immutable deployer;
  /// @notice Where the session-open fee goes. Zero (the default) charges no session fee.
  address public feeSink;
  /// @notice The session-open fee, in basis points of the session, paid to `feeSink`.
  uint256 public sessionFeeBPS;

  event SessionFunded(address indexed session, uint256 shares, uint256 amount, uint256 relayFee, uint256 toDepositors);
  event SessionFee(uint256 fee);
  event FeeSinkSet(address sink, uint256 sessionFeeBPS);

  error WrongProcessooor();
  error RelayFeeTooHigh();
  error NotEnough(uint256 assets, uint256 needed);
  error NotDeployer();
  error FeeSinkAlreadySet();
  error BadFeeSink();

  constructor(IPrivacyPool pool_, SodiYieldVault vault_, uint256 protocolFeeBPS_) {
    pool = pool_;
    vault = vault_;
    usdg = IERC20(vault_.asset());
    protocolFeeBPS = protocolFeeBPS_;
    deployer = msg.sender;
    require(pool_.ASSET() == address(vault_) && protocolFeeBPS_ <= 1_000, 'bad config');
  }

  /// @notice Turns on the session-open fee: `bps` of every session from now on, paid to `sink`.
  ///         Once only, by the deployer; it can't be changed or turned off afterwards.
  function setFeeSink(address sink, uint256 bps) external {
    if (msg.sender != deployer) revert NotDeployer();
    if (feeSink != address(0)) revert FeeSinkAlreadySet();
    if (sink == address(0) || bps == 0 || bps > MAX_SESSION_FEE_BPS) revert BadFeeSink();
    feeSink = sink;
    sessionFeeBPS = bps;
    emit FeeSinkSet(sink, bps);
  }

  /// @notice USDG the shares of a withdrawal must be worth to fund a session of `amount`.
  function needed(uint256 amount, uint256 relayFeeBPS) public view returns (uint256) {
    return amount + _fee(amount, protocolFeeBPS) + _fee(amount, relayFeeBPS) + _fee(amount, sessionFeeBPS);
  }

  function fund(IPrivacyPool.Withdrawal calldata w, ProofLib.WithdrawProof calldata proof) external nonReentrant {
    if (w.processooor != address(this)) revert WrongProcessooor();
    FundingData memory d = abi.decode(w.data, (FundingData));
    if (d.relayFeeBPS > MAX_RELAY_FEE_BPS) revert RelayFeeTooHigh();

    uint256 shares = proof.pubSignals[2];
    pool.withdraw(w, proof); // checks the proof, the context and the approval root; sends the shares here
    uint256 assets = vault.redeem(shares, address(this), address(this));

    uint256 relayFee = _fee(d.amount, d.relayFeeBPS);
    uint256 need = needed(d.amount, d.relayFeeBPS);
    if (assets < need) revert NotEnough(assets, need);
    uint256 sessionFee = _fee(d.amount, sessionFeeBPS); // zero until a fee sink is set
    // The depositors' protocol fee plus whatever the margin left over.
    uint256 toDepositors = assets - d.amount - relayFee - sessionFee;

    usdg.safeTransfer(d.session, d.amount);
    if (relayFee > 0) usdg.safeTransfer(d.feeRecipient, relayFee);
    if (sessionFee > 0) {
      usdg.safeTransfer(feeSink, sessionFee);
      emit SessionFee(sessionFee);
    }
    if (toDepositors > 0) {
      usdg.forceApprove(address(vault), toDepositors);
      vault.donate(toDepositors);
    }
    emit SessionFunded(d.session, shares, d.amount, relayFee, toDepositors);
  }

  /// @dev Rounded up, so fees are never short.
  function _fee(uint256 amount, uint256 bps) internal pure returns (uint256) {
    return (amount * bps + 9_999) / 10_000;
  }
}
