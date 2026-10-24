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

  event SessionFunded(address indexed session, uint256 shares, uint256 amount, uint256 relayFee, uint256 toDepositors);

  error WrongProcessooor();
  error RelayFeeTooHigh();
  error NotEnough(uint256 assets, uint256 needed);

  constructor(IPrivacyPool pool_, SodiYieldVault vault_, uint256 protocolFeeBPS_) {
    pool = pool_;
    vault = vault_;
    usdg = IERC20(vault_.asset());
    protocolFeeBPS = protocolFeeBPS_;
    require(pool_.ASSET() == address(vault_) && protocolFeeBPS_ <= 1_000, 'bad config');
  }

  /// @notice USDG the shares of a withdrawal must be worth to fund a session of `amount`.
  function needed(uint256 amount, uint256 relayFeeBPS) public view returns (uint256) {
    return amount + _fee(amount, protocolFeeBPS) + _fee(amount, relayFeeBPS);
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
    // The protocol fee plus whatever the margin left over.
    uint256 toDepositors = assets - d.amount - relayFee;

    usdg.safeTransfer(d.session, d.amount);
    if (relayFee > 0) usdg.safeTransfer(d.feeRecipient, relayFee);
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
