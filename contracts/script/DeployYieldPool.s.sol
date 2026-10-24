// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from 'forge-std/Script.sol';
import {console} from 'forge-std/console.sol';

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {IERC4626} from '@oz/interfaces/IERC4626.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {PrivacyPoolComplex} from 'contracts/implementations/PrivacyPoolComplex.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {SodiSessionFunder} from '../src/yield/SodiSessionFunder.sol';
import {SodiYieldDepositor} from '../src/yield/SodiYieldDepositor.sol';
import {SodiYieldVault} from '../src/yield/SodiYieldVault.sol';
import {TestnetStandInVault} from '../src/yield/testnet/TestnetStandInVault.sol';

/**
 * @title Deploy the yield pool on Robinhood Chain testnet (prototype)
 * @notice Morpho isn't on testnet, so SodiYieldVault invests in a plain ERC-4626 stand-in. Reuses the
 *         deployed Entrypoint (the broadcaster must be its owner), verifiers and Poseidon libraries
 *         (pass them with --libraries). Wires the vault with a small seed deposit from the broadcaster.
 *
 *   GUARDIAN_ADDRESS  may exit to idle and cancel vault changes (use a different key from the owner)
 *   SEED              seed deposit in USDG base units (default 1000 = 0.001 USDG)
 */
contract YieldPoolTestnet is Script {
  address internal constant USDG = 0x7E955252E15c84f5768B83c41a71F9eba181802F;
  address internal constant ENTRYPOINT = 0xaCa6B50b648a6f575a009DC7c97aBe62808869Ce;
  address internal constant WITHDRAWAL_VERIFIER = 0x2740523E66d4a74002B8e11c839AbbF86A084c71;
  address internal constant COMMITMENT_VERIFIER = 0x58E37acaf8B2B2f61c3A65E1db59A7dEcb879061;
  uint256 internal constant MIN_DEPOSIT = 10_000; // 0.01 USDG of shares
  uint256 internal constant PROTOCOL_FEE_BPS = 50;

  function run() external {
    require(block.chainid == 46_630, 'testnet only');
    address guardian = vm.envAddress('GUARDIAN_ADDRESS');
    uint256 seed = vm.envOr('SEED', uint256(1_000));

    vm.startBroadcast();
    (, address owner,) = vm.readCallers();
    TestnetStandInVault standIn = new TestnetStandInVault(IERC20(USDG));
    SodiYieldVault vault = new SodiYieldVault(IERC20(USDG), IERC4626(address(standIn)), owner, guardian);
    address pool = address(new PrivacyPoolComplex(ENTRYPOINT, WITHDRAWAL_VERIFIER, COMMITMENT_VERIFIER, address(vault)));
    Entrypoint(payable(ENTRYPOINT)).registerPool(IERC20(address(vault)), IPrivacyPool(pool), MIN_DEPOSIT, 0, 100);
    SodiYieldDepositor router = new SodiYieldDepositor(Entrypoint(payable(ENTRYPOINT)), vault);
    SodiSessionFunder funder = new SodiSessionFunder(IPrivacyPool(pool), vault, PROTOCOL_FEE_BPS);
    IERC20(USDG).approve(address(vault), seed);
    vault.wire(pool, ENTRYPOINT, address(router), address(funder), seed);
    vm.stopBroadcast();

    console.log('TestnetStandInVault: %s', address(standIn));
    console.log('SodiYieldVault:      %s', address(vault));
    console.log('Yield pool:          %s', pool);
    console.log('Pool scope:          %s', IPrivacyPool(pool).SCOPE());
    console.log('SodiYieldDepositor:  %s', address(router));
    console.log('SodiSessionFunder:   %s', address(funder));
  }
}
