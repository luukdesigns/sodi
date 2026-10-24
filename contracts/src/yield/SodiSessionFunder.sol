// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {IERC4626} from '@oz/interfaces/IERC4626.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

/// @title SodiSessionFunder (prototype)
/// @notice Turns a zero-knowledge withdrawal of yield-vault shares into a USDG session, in one
///         transaction.
///
///         It is the withdrawal's processooor: the proof commits to this contract and to the funding data
///         (session, relayer fee recipient, relayer fee, minimum USDG), so whoever submits it, usually a
///         relayer, can't change any of them. The pool checks the proof and the latest approval root and
///         sends the shares here; this contract redeems them, donates the protocol fee to the yield vault,
///         pays the relayer and sends the rest to the session as plain USDG.
///
///         PROTOTYPE: not audited, not deployed. See docs/yield-pool-design.md.
contract SodiSessionFunder is ReentrancyGuard {
  using SafeERC20 for IERC20;

  struct FundingData {
    address session;
    address feeRecipient;
    uint256 relayFeeBPS;
    uint256 minAssets;
  }

  IPrivacyPool public immutable pool;
  IERC4626 public immutable vault;
  IERC20 public immutable usdg;
  /// @notice Share of each session's USDG donated to the yield vault, in basis points.
  uint256 public immutable protocolFeeBPS;
  uint256 public constant MAX_RELAY_FEE_BPS = 100;

  event SessionFunded(address indexed session, uint256 shares, uint256 assets, uint256 protocolFee, uint256 relayFee);

  error WrongProcessooor();
  error RelayFeeTooHigh();
  error BelowMinimum(uint256 toSession, uint256 minAssets);

  constructor(IPrivacyPool pool_, IERC4626 vault_, uint256 protocolFeeBPS_) {
    pool = pool_;
    vault = vault_;
    usdg = IERC20(vault_.asset());
    protocolFeeBPS = protocolFeeBPS_;
    require(pool_.ASSET() == address(vault_) && protocolFeeBPS_ <= 1_000, 'bad config');
  }

  function fund(IPrivacyPool.Withdrawal calldata w, ProofLib.WithdrawProof calldata proof) external nonReentrant {
    if (w.processooor != address(this)) revert WrongProcessooor();
    FundingData memory d = abi.decode(w.data, (FundingData));
    if (d.relayFeeBPS > MAX_RELAY_FEE_BPS) revert RelayFeeTooHigh();

    uint256 shares = proof.pubSignals[2];
    pool.withdraw(w, proof); // checks the proof, the context and the approval root; sends the shares here
    uint256 assets = vault.redeem(shares, address(this), address(this));

    uint256 protocolFee = (assets * protocolFeeBPS) / 10_000;
    uint256 relayFee = (assets * d.relayFeeBPS) / 10_000;
    uint256 toSession = assets - protocolFee - relayFee;
    if (toSession < d.minAssets) revert BelowMinimum(toSession, d.minAssets);

    if (protocolFee > 0) usdg.safeTransfer(address(vault), protocolFee);
    if (relayFee > 0) usdg.safeTransfer(d.feeRecipient, relayFee);
    usdg.safeTransfer(d.session, toSession);
    emit SessionFunded(d.session, shares, assets, protocolFee, relayFee);
  }
}
