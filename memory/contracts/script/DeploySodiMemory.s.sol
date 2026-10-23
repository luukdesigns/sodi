// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from 'forge-std/Script.sol';
import {console} from 'forge-std/console.sol';

import {SodiMemory} from '../src/SodiMemory.sol';

contract DeploySodiMemory is Script {
  function run() external returns (SodiMemory mem) {
    vm.startBroadcast();
    mem = new SodiMemory();
    vm.stopBroadcast();
    console.log('SodiMemory deployed at %s on chain %s', address(mem), block.chainid);
  }
}
