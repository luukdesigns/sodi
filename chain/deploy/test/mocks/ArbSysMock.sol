// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice Stand-in for the ArbSys precompile (0x64) on an anvil fork of an Arbitrum chain, which has no
///         Arbitrum precompiles. Covers the calls the RollupCreator makes. Fork testing only.
contract ArbSysMock {
    function arbBlockNumber() external view returns (uint256) {
        return block.number;
    }

    function arbBlockHash(uint256 n) external view returns (bytes32) {
        return blockhash(n);
    }

    function arbChainID() external view returns (uint256) {
        return block.chainid;
    }

    /// ArbOS 61, as reported by Robinhood Chain testnet (ArbSys adds 55).
    function arbOSVersion() external pure returns (uint256) {
        return 116;
    }

    function isTopLevelCall() external view returns (bool) {
        return msg.sender == tx.origin;
    }

    function wasMyCallersAddressAliased() external pure returns (bool) {
        return false;
    }

    function myCallersAddressWithoutAliasing() external view returns (address) {
        return msg.sender;
    }
}
