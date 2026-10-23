// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @notice ERC-5564 announcer interface. The canonical announcer is deployed on Robinhood Chain at
///         0x55649E01B5Df198D18D95b5cc5051630cfD45564.
interface IERC5564Announcer {
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external;
}

/// @title SodiStealthSettler
/// @notice Settles an x402 payment to a merchant's stealth address and announces it, in one transaction.
///
///         The payer signs an ordinary EIP-3009 authorization whose recipient is a one-time stealth
///         address derived from the merchant's ERC-5564 meta-address. Whoever settles it (the merchant
///         or a shared facilitator) calls `settle`, which moves the funds and emits the ERC-5564
///         announcement the merchant scans for. The announcement can't be skipped or forged for a
///         payment that went through here, so a merchant can always find its funds from the chain alone.
///
///         The contract holds nothing and has no owner.
contract SodiStealthSettler {
    /// @notice ERC-5564 scheme 1: SECP256k1 with view tags.
    uint256 public constant SCHEME_ID = 1;

    /// @notice Selector recorded in the announcement metadata: the call that moved the funds.
    bytes4 public constant TRANSFER_WITH_AUTHORIZATION = IERC3009.transferWithAuthorization.selector;

    IERC5564Announcer public immutable announcer;

    struct Payment {
        address token;
        address from;
        address stealthAddress;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    error BadEphemeralKey();

    constructor(IERC5564Announcer announcer_) {
        announcer = announcer_;
    }

    /// @param p The EIP-3009 authorization, paying `p.stealthAddress`.
    /// @param ephemeralPubKey The payer's 33-byte compressed ephemeral public key.
    /// @param viewTag The first byte of the hashed shared secret, so scanners can skip most announcements.
    function settle(Payment calldata p, bytes calldata ephemeralPubKey, bytes1 viewTag) external {
        if (ephemeralPubKey.length != 33 || (ephemeralPubKey[0] != 0x02 && ephemeralPubKey[0] != 0x03)) {
            revert BadEphemeralKey();
        }
        IERC3009(p.token).transferWithAuthorization(
            p.from, p.stealthAddress, p.value, p.validAfter, p.validBefore, p.nonce, p.v, p.r, p.s
        );
        // ERC-5564 metadata: view tag | selector | token | amount
        announcer.announce(
            SCHEME_ID,
            p.stealthAddress,
            ephemeralPubKey,
            abi.encodePacked(viewTag, TRANSFER_WITH_AUTHORIZATION, p.token, p.value)
        );
    }
}
