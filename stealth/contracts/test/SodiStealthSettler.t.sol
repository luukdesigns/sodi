// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";

import {IERC5564Announcer, SodiStealthSettler} from "../src/SodiStealthSettler.sol";
import {ERC5564Announcer} from "../src/test/ERC5564Announcer.sol";
import {TestDollar3009} from "../src/test/TestDollar3009.sol";

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
        settler = new SodiStealthSettler(IERC5564Announcer(address(announcer)));
        token = new TestDollar3009();
        payer = vm.addr(payerKey);
        token.mint(payer, 10e6);
    }

    function _payment(address to, uint256 value, bytes32 nonce) internal view returns (SodiStealthSettler.Payment memory p) {
        p.token = address(token);
        p.from = payer;
        p.stealthAddress = to;
        p.value = value;
        p.validAfter = 0;
        p.validBefore = block.timestamp + 300;
        p.nonce = nonce;
        bytes32 structHash = keccak256(
            abi.encode(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, to, value, p.validAfter, p.validBefore, nonce)
        );
        (p.v, p.r, p.s) =
            vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
    }

    function test_settlesAndAnnounces() public {
        SodiStealthSettler.Payment memory p = _payment(stealth, 1.5e6, bytes32("n1"));
        vm.expectEmit(address(announcer));
        emit Announcement(
            1, stealth, address(settler), ephPub, abi.encodePacked(viewTag, bytes4(0xe3ee160e), address(token), uint256(1.5e6))
        );
        settler.settle(p, ephPub, viewTag);
        assertEq(token.balanceOf(stealth), 1.5e6);
        assertEq(token.balanceOf(payer), 8.5e6);
    }

    function test_metadataLayoutMatchesErc5564() public {
        vm.recordLogs();
        settler.settle(_payment(stealth, 7, bytes32("n2")), ephPub, viewTag);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (bytes memory eph, bytes memory meta) = abi.decode(logs[logs.length - 1].data, (bytes, bytes));
        assertEq(eph, ephPub);
        assertEq(meta.length, 1 + 4 + 20 + 32);
        assertEq(meta[0], viewTag);
    }

    function test_anyoneCanSettle() public {
        SodiStealthSettler.Payment memory p = _payment(stealth, 1e6, bytes32("n3"));
        vm.prank(address(0xFAC));
        settler.settle(p, ephPub, viewTag);
        assertEq(token.balanceOf(stealth), 1e6);
    }

    function test_rejectsRedirectedRecipient() public {
        SodiStealthSettler.Payment memory p = _payment(stealth, 1e6, bytes32("n4"));
        p.stealthAddress = address(0xBAD);
        vm.expectRevert(TestDollar3009.InvalidSignature.selector);
        settler.settle(p, ephPub, viewTag);
    }

    function test_rejectsReplay() public {
        SodiStealthSettler.Payment memory p = _payment(stealth, 1e6, bytes32("n5"));
        settler.settle(p, ephPub, viewTag);
        vm.expectRevert(TestDollar3009.AuthorizationUsedAlready.selector);
        settler.settle(p, ephPub, viewTag);
    }

    function test_rejectsMalformedEphemeralKey() public {
        SodiStealthSettler.Payment memory p = _payment(stealth, 1e6, bytes32("n6"));
        vm.expectRevert(SodiStealthSettler.BadEphemeralKey.selector);
        settler.settle(p, abi.encodePacked(bytes32(0)), viewTag);
        bytes memory wrongPrefix = abi.encodePacked(bytes1(0x04), bytes32(uint256(1)));
        vm.expectRevert(SodiStealthSettler.BadEphemeralKey.selector);
        settler.settle(p, wrongPrefix, viewTag);
    }

    function test_nothingStaysInTheSettler() public {
        settler.settle(_payment(stealth, 3e6, bytes32("n7")), ephPub, viewTag);
        assertEq(token.balanceOf(address(settler)), 0);
    }
}
