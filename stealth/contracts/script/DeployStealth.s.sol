// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from 'forge-std/Script.sol';
import {console} from 'forge-std/console.sol';

import {IERC5564Announcer, SodiStealthSettler} from '../src/SodiStealthSettler.sol';
import {TestDollar3009} from '../src/test/TestDollar3009.sol';

/// Deploys the settler against the canonical ERC-5564 announcer. It accepts the tokens in the
/// comma-separated SETTLER_TOKENS, plus, on testnet, a test dollar with EIP-3009 deployed here for
/// demos (set DEPLOY_TEST_TOKEN=false to skip it).
contract DeployStealth is Script {
  IERC5564Announcer constant ANNOUNCER = IERC5564Announcer(0x55649E01B5Df198D18D95b5cc5051630cfD45564);

  function run() external returns (SodiStealthSettler settler, TestDollar3009 token) {
    require(address(ANNOUNCER).code.length > 0, 'ERC-5564 announcer not deployed on this chain');
    address[] memory listed = vm.envOr('SETTLER_TOKENS', ',', new address[](0));
    bool withTestToken = vm.envOr('DEPLOY_TEST_TOKEN', true);
    vm.startBroadcast();
    if (withTestToken) token = new TestDollar3009();
    address[] memory tokens = new address[](listed.length + (withTestToken ? 1 : 0));
    for (uint256 i; i < listed.length; ++i) tokens[i] = listed[i];
    if (withTestToken) tokens[listed.length] = address(token);
    settler = new SodiStealthSettler(ANNOUNCER, tokens);
    vm.stopBroadcast();
    console.log('SodiStealthSettler %s', address(settler));
    console.log('TestDollar3009     %s', address(token));
  }
}
