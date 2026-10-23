// SPDX-License-Identifier: CC0-1.0
// Reference implementation from ERC-8183 (Agentic Commerce), copied verbatim from
// https://github.com/ethereum/ERCs/blob/831b1c15a6d83bf3fbb46c6ce4c2c8ec13a59743/ERCS/erc-8183.md
// Copyright and related rights waived via CC0. Only this header was added.
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IACPHook is IERC165 {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}
