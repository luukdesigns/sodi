// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.28;

import {IERC5564Announcer} from "../SodiStealthSettler.sol";

/// @notice The ERC-5564 reference announcer, for local tests. On Robinhood Chain the canonical
///         deployment at 0x55649E01B5Df198D18D95b5cc5051630cfD45564 is used instead.
contract ERC5564Announcer is IERC5564Announcer {
    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external
    {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}
