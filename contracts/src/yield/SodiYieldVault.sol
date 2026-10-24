// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {ERC20} from '@oz/token/ERC20/ERC20.sol';
import {ERC4626} from '@oz/token/ERC20/extensions/ERC4626.sol';
import {IERC4626} from '@oz/interfaces/IERC4626.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';

/// @title SodiYieldVault (prototype)
/// @notice An ERC-4626 vault over USDG that puts everything it holds into an underlying ERC-4626
///         vault (the Steakhouse USDG Morpho vault on Robinhood Chain). Its shares are the asset of the
///         Sodi yield pool.
///
///         Interest earned by the underlying vault raises this vault's share price with no transaction.
///         USDG sent to it directly (the protocol fee from each session) counts towards its assets at
///         once, so it raises the share price for this vault's holders only, not for everyone in the
///         underlying vault.
///
///         Shares have the same 6 decimals as USDG. Against the ERC-4626 donation attack it relies on
///         OpenZeppelin's virtual share and a seed deposit made at deployment and never withdrawn.
///
///         PROTOTYPE: not audited, not deployed. See docs/yield-pool-design.md.
contract SodiYieldVault is ERC4626 {
  using SafeERC20 for IERC20;

  IERC4626 public immutable underlying;

  error AssetMismatch();

  event Invested(uint256 assets, uint256 underlyingShares);

  constructor(IERC20 usdg, IERC4626 underlying_) ERC20('Sodi Yield USDG', 'syUSDG') ERC4626(usdg) {
    if (underlying_.asset() != address(usdg)) revert AssetMismatch();
    underlying = underlying_;
  }

  /// @notice USDG held here plus what the underlying shares would redeem for now, rounded down.
  function totalAssets() public view override returns (uint256) {
    return IERC20(asset()).balanceOf(address(this)) + underlying.previewRedeem(underlying.balanceOf(address(this)));
  }

  /// @notice Puts any USDG held here (donated fees, say) into the underlying vault. Anyone may call it.
  function invest() public {
    uint256 idle = IERC20(asset()).balanceOf(address(this));
    if (idle == 0) return;
    IERC20(asset()).forceApprove(address(underlying), idle);
    uint256 got = underlying.deposit(idle, address(this));
    emit Invested(idle, got);
  }

  function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
    super._deposit(caller, receiver, assets, shares);
    invest();
  }

  function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
    internal
    override
  {
    uint256 idle = IERC20(asset()).balanceOf(address(this));
    if (idle < assets) underlying.withdraw(assets - idle, address(this), address(this));
    super._withdraw(caller, receiver, owner, assets, shares);
  }
}
