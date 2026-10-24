// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IERC3009Receive {
    function receiveWithAuthorization(
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
/// @notice Settles an x402 payment to a merchant's one-time stealth address and announces it, in one
///         transaction that no one can split or alter.
///
///         The payer signs an EIP-3009 `ReceiveWithAuthorization` paying THIS contract, with a nonce
///         that commits to the stealth address, the ephemeral public key and the view tag. Because
///         `receiveWithAuthorization` can only be executed by its recipient, the funds can only move
///         through `settle`; and because the nonce is part of the signature, `settle` can only be called
///         with the announcement data the payer signed. So every payment is announced exactly as the
///         merchant needs to find it, whoever submits it.
///
///         Only tokens fixed at deployment are accepted, so announcements from this contract always
///         describe real payments. It holds nothing between calls and has no owner.
contract SodiStealthSettler {
    using SafeERC20 for IERC20;

    /// @notice ERC-5564 scheme 1: SECP256k1 with view tags.
    uint256 public constant SCHEME_ID = 1;

    /// @notice Selector recorded in the announcement metadata: the call that moved the funds.
    bytes4 public constant RECEIVE_WITH_AUTHORIZATION = IERC3009Receive.receiveWithAuthorization.selector;

    /// @notice Domain tag of the nonce commitment.
    bytes32 public constant NONCE_TAG = keccak256("sodi-stealth-settle-v1");

    IERC5564Announcer public immutable announcer;
    mapping(address token => bool) public acceptedToken;

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
    error TokenNotAccepted();
    error NonceMismatch();

    constructor(IERC5564Announcer announcer_, address[] memory tokens) {
        announcer = announcer_;
        for (uint256 i; i < tokens.length; ++i) {
            acceptedToken[tokens[i]] = true;
        }
    }

    /// @notice The nonce a payer must sign for a payment to `stealthAddress` with this announcement data.
    function stealthNonce(address stealthAddress, bytes calldata ephemeralPubKey, bytes1 viewTag)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(NONCE_TAG, stealthAddress, keccak256(ephemeralPubKey), viewTag));
    }

    /// @param p The EIP-3009 receive authorization (to = this contract) and the stealth address it pays.
    /// @param ephemeralPubKey The payer's 33-byte compressed ephemeral public key.
    /// @param viewTag The first byte of the hashed shared secret, so scanners can skip most announcements.
    function settle(Payment calldata p, bytes calldata ephemeralPubKey, bytes1 viewTag) external {
        if (!acceptedToken[p.token]) revert TokenNotAccepted();
        if (ephemeralPubKey.length != 33 || (ephemeralPubKey[0] != 0x02 && ephemeralPubKey[0] != 0x03)) {
            revert BadEphemeralKey();
        }
        if (p.nonce != stealthNonce(p.stealthAddress, ephemeralPubKey, viewTag)) revert NonceMismatch();

        IERC3009Receive(p.token).receiveWithAuthorization(
            p.from, address(this), p.value, p.validAfter, p.validBefore, p.nonce, p.v, p.r, p.s
        );
        IERC20(p.token).safeTransfer(p.stealthAddress, p.value);

        // ERC-5564 metadata: view tag | selector | token | amount
        announcer.announce(
            SCHEME_ID, p.stealthAddress, ephemeralPubKey, abi.encodePacked(viewTag, RECEIVE_WITH_AUTHORIZATION, p.token, p.value)
        );
    }
}
