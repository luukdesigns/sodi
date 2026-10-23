// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice Stand-in for the ArbGasInfo precompile (0x6c) on an anvil fork. Robinhood Chain testnet
///         reports an L1 base fee estimate of 0, so this does too. Fork testing only.
contract ArbGasInfoMock {
    function getL1BaseFeeEstimate() external pure returns (uint256) {
        return 0;
    }

    function getL1GasPriceEstimate() external pure returns (uint256) {
        return 0;
    }

    function getMinimumGasPrice() external view returns (uint256) {
        return block.basefee;
    }
}
