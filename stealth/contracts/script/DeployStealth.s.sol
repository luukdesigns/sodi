// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from 'forge-std/Script.sol';
import {console} from 'forge-std/console.sol';

import {IERC5564Announcer, SodiStealthSettler} from '../src/SodiStealthSettler.sol';
import {TestDollar3009} from '../src/test/TestDollar3009.sol';

/// Deploys the settler against the canonical ERC-5564 announcer and, on testnet, a test dollar with
/// EIP-3009 for demos (set DEPLOY_TEST_TOKEN=false to skip it).
contract DeployStealth is Script {
  IERC5564Announcer constant ANNOUNCER = IERC5564Announcer(0x55649E01B5Df198D18D95b5cc5051630cfD45564);

  function run() external returns (SodiStealthSettler settler, TestDollar3009 token) {
    require(address(ANNOUNCER).code.length > 0, 'ERC-5564 announcer not deployed on this chain');
    vm.startBroadcast();
    settler = new SodiStealthSettler(ANNOUNCER);
    if (vm.envOr('DEPLOY_TEST_TOKEN', true)) token = new TestDollar3009();
    vm.stopBroadcast();
    console.log('SodiStealthSettler %s', address(settler));
    console.log('TestDollar3009     %s', address(token));
  }
}
