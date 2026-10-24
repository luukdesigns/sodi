// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {ERC20} from '@oz/token/ERC20/ERC20.sol';
import {ERC4626} from '@oz/token/ERC20/extensions/ERC4626.sol';

/// @title TestnetStandInVault
/// @notice TESTNET ONLY. A plain OpenZeppelin ERC-4626 vault over testnet USDG, standing in for the
///         Steakhouse USDG Morpho vault, which isn't deployed on Robinhood Chain testnet. It has the same
///         interface SodiYieldVault uses in production and nothing else: it earns no yield. Its share
///         price rises only if someone sends it USDG, and anything that does so must be labelled as
///         simulated wherever it's shown.
contract TestnetStandInVault is ERC4626 {
  constructor(IERC20 usdg) ERC20('Sodi testnet stand-in vault (no real yield)', 'standinUSDG') ERC4626(usdg) {}
}
