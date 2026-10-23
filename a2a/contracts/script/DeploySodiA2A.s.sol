// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from 'forge-std/Script.sol';
import {console} from 'forge-std/console.sol';

import {SodiA2A} from '../src/SodiA2A.sol';

contract DeploySodiA2A is Script {
  function run() external returns (SodiA2A a2a) {
    vm.startBroadcast();
    a2a = new SodiA2A();
    vm.stopBroadcast();
    console.log('SodiA2A deployed at %s on chain %s', address(a2a), block.chainid);
  }
}
