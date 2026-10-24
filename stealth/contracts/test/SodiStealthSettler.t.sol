// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";

import {IERC5564Announcer, SodiStealthSettler} from "../src/SodiStealthSettler.sol";
import {ERC5564Announcer} from "../src/test/ERC5564Announcer.sol";
import {TestDollar3009} from "../src/test/TestDollar3009.sol";

/// @notice A token that accepts any authorization and moves nothing: an attacker's way of faking payments.
contract FakeToken {
    function receiveWithAuthorization(address, address, uint256, uint256, uint256, bytes32, uint8, bytes32, bytes32)
        external {}

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}

contract SodiStealthSettlerTest is Test {
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    ERC5564Announcer announcer;
    SodiStealthSettler settler;
    TestDollar3009 token;

    uint256 payerKey = 0xA11CE;
    address payer;
    address stealth = address(0x5EA1);
    bytes ephPub = abi.encodePacked(bytes1(0x02), bytes32(uint256(0x1234)));
    bytes1 viewTag = 0xab;

    function setUp() public {
        announcer = new ERC5564Announcer();
        token = new TestDollar3009();
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        settler = new SodiStealthSettler(IERC5564Announcer(address(announcer)), tokens);
        payer = vm.addr(payerKey);
        token.mint(payer, 10e6);
    }

    function _sign(bytes32 typehash, address to, uint256 value, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(typehash, payer, to, value, uint256(0), validBefore, nonce));
        return vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
    }

    /// A payment the payer signed for `stealthAddress` with the given announcement data.
    function _payment(address stealthAddress, uint256 value, bytes memory eph, bytes1 tag)
        internal
        view
        returns (SodiStealthSettler.Payment memory p)
    {
        p.token = address(token);
        p.from = payer;
        p.stealthAddress = stealthAddress;
        p.value = value;
        p.validBefore = block.timestamp + 300;
        p.nonce = this.nonceFor(stealthAddress, eph, tag);
        (p.v, p.r, p.s) = _sign(token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), address(settler), value, p.validBefore, p.nonce);
    }

    function nonceFor(address a, bytes calldata eph, bytes1 tag) external view returns (bytes32) {
        return settler.stealthNonce(a, eph, tag);
    }

    function test_settlesAndAnnounces() public {
        SodiStealthSettler.Payment memory p = _payment(stealth, 1.5e6, ephPub, viewTag);
        vm.expectEmit(address(announcer));
        emit Announcement(
            1, stealth, address(settler), ephPub, abi.encodePacked(viewTag, bytes4(0xef55bec6), address(token), uint256(1.5e6))
        );
        settler.settle(p, ephPub, viewTag);
        assertEq(token.balanceOf(stealth), 1.5e6);
        assertEq(token.balanceOf(payer), 8.5e6);
        assertEq(token.balanceOf(address(settler)), 0);
    }

    function test_metadataLayoutMatchesErc5564() public {
        vm.recordLogs();
        settler.settle(_payment(stealth, 7, ephPub, viewTag), ephPub, viewTag);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (bytes memory eph, bytes memory meta) = abi.decode(logs[logs.length - 1].data, (bytes, bytes));
        assertEq(eph, ephPub);
        assertEq(meta.length, 1 + 4 + 20 + 32);
        assertEq(meta[0], viewTag);
    }

    function test_anyoneCanSettle() public {
        SodiStealthSettler.Payment memory p = _payment(stealth, 1e6, ephPub, viewTag);
        vm.prank(address(0xFAC));
        settler.settle(p, ephPub, viewTag);
        assertEq(token.balanceOf(stealth), 1e6);
    }

    // --- the review's attacks -------------------------------------------------------------------

    /// Front-running with junk announcement data fails: the nonce, and so the signature, binds it.
    function test_rejectsForgedEphemeralKeyOrViewTag() public {
        SodiStealthSettler.Payment memory p = _payment(stealth, 1e6, ephPub, viewTag);
        bytes memory junk = abi.encodePacked(bytes1(0x03), bytes32(uint256(0xbad)));
        vm.expectRevert(SodiStealthSettler.NonceMismatch.selector);
        settler.settle(p, junk, viewTag);
        vm.expectRevert(SodiStealthSettler.NonceMismatch.selector);
        settler.settle(p, ephPub, bytes1(0x00));
        // The honest settlement still goes through afterwards.
        settler.settle(p, ephPub, viewTag);
        assertEq(token.balanceOf(stealth), 1e6);
    }

    /// The funds can't be moved without the announcement: only the settler can execute the authorization.
    function test_cannotBypassTheSettler() public {
        SodiStealthSettler.Payment memory p = _payment(stealth, 1e6, ephPub, viewTag);
        vm.expectRevert(TestDollar3009.CallerMustBePayee.selector);
        token.receiveWithAuthorization(payer, address(settler), p.value, 0, p.validBefore, p.nonce, p.v, p.r, p.s);
        // Nor can the same signature be used as a transfer authorization (different EIP-712 type).
        vm.expectRevert(TestDollar3009.InvalidSignature.selector);
        token.transferWithAuthorization(payer, address(settler), p.value, 0, p.validBefore, p.nonce, p.v, p.r, p.s);
    }

    /// Redirecting the funds to another address breaks the nonce commitment.
    function test_rejectsRedirectedStealthAddress() public {
        SodiStealthSettler.Payment memory p = _payment(stealth, 1e6, ephPub, viewTag);
        p.stealthAddress = address(0xBAD);
        vm.expectRevert(SodiStealthSettler.NonceMismatch.selector);
        settler.settle(p, ephPub, viewTag);
    }

    /// A token that moves nothing can't be used to announce fake payments.
    function test_rejectsTokensNotFixedAtDeployment() public {
        SodiStealthSettler.Payment memory p = _payment(stealth, 1e30, ephPub, viewTag);
        p.token = address(new FakeToken());
        vm.expectRevert(SodiStealthSettler.TokenNotAccepted.selector);
        settler.settle(p, ephPub, viewTag);
    }

    function test_rejectsReplay() public {
        SodiStealthSettler.Payment memory p = _payment(stealth, 1e6, ephPub, viewTag);
        settler.settle(p, ephPub, viewTag);
        vm.expectRevert(TestDollar3009.AuthorizationUsedAlready.selector);
        settler.settle(p, ephPub, viewTag);
    }

    function test_rejectsMalformedEphemeralKey() public {
        SodiStealthSettler.Payment memory p = _payment(stealth, 1e6, ephPub, viewTag);
        vm.expectRevert(SodiStealthSettler.BadEphemeralKey.selector);
        settler.settle(p, abi.encodePacked(bytes32(0)), viewTag);
        bytes memory wrongPrefix = abi.encodePacked(bytes1(0x04), bytes32(uint256(1)));
        vm.expectRevert(SodiStealthSettler.BadEphemeralKey.selector);
        settler.settle(p, wrongPrefix, viewTag);
    }
}
