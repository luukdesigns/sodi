// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';

import {SodiA2A} from '../src/SodiA2A.sol';

contract SodiA2ATest is Test {
  SodiA2A internal a2a;
  uint256 internal aliceKey = 0xA11CE;
  address internal alice;
  address internal bob = makeAddr('bob');
  address internal mallory = makeAddr('mallory');
  address internal relayer = makeAddr('relayer');

  event Posted(uint256 indexed channelId, address indexed author, bytes envelope);

  function setUp() public {
    a2a = new SodiA2A();
    alice = vm.addr(aliceKey);
  }

  function _envelope(uint256 size) internal pure returns (bytes memory e) {
    e = new bytes(size);
    e[0] = 0xA2;
    e[1] = 0x01;
  }

  function _sign(bytes32 structHash) internal view returns (bytes memory) {
    bytes32 digest = keccak256(abi.encodePacked('\x19\x01', a2a.domainSeparator(), structHash));
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digest);
    return abi.encodePacked(r, s, v);
  }

  // ---------------------------------------------------------------- keys

  function test_SetKey() public {
    vm.prank(bob);
    a2a.setKey(bytes32(uint256(7)));
    assertEq(a2a.encryptionKey(bob), bytes32(uint256(7)));
  }

  function test_RevertWhen_KeyIsZero() public {
    vm.expectRevert(SodiA2A.InvalidKey.selector);
    a2a.setKey(bytes32(0));
  }

  function test_SetKeyFor_WithSignature() public {
    bytes32 key = bytes32(uint256(42));
    bytes32 sh = keccak256(abi.encode(a2a.SET_KEY_TYPEHASH(), alice, key, 0, block.timestamp + 1));
    vm.prank(relayer);
    a2a.setKeyFor(alice, key, block.timestamp + 1, _sign(sh));
    assertEq(a2a.encryptionKey(alice), key);
    assertEq(a2a.nonces(alice), 1);
  }

  // ---------------------------------------------------------------- posting

  function test_AnyoneCanPostToChannelZero() public {
    bytes memory e = _envelope(200);
    vm.expectEmit(true, true, false, true);
    emit Posted(0, mallory, e);
    vm.prank(mallory);
    a2a.post(0, e);
  }

  function test_RevertWhen_EnvelopeLacksHeader() public {
    bytes memory e = _envelope(200);
    e[0] = 'h'; // e.g. plaintext "hello..."
    vm.expectRevert(SodiA2A.InvalidEnvelope.selector);
    a2a.post(0, e);
  }

  function test_RevertWhen_EnvelopeTooSmallOrLarge() public {
    uint256 min = a2a.MIN_ENVELOPE();
    uint256 max = a2a.MAX_ENVELOPE();
    vm.expectRevert(SodiA2A.InvalidEnvelope.selector);
    a2a.post(0, _envelope(min - 1));
    vm.expectRevert(SodiA2A.InvalidEnvelope.selector);
    a2a.post(0, _envelope(max + 1));
    a2a.post(0, _envelope(max));
    a2a.post(0, _envelope(min));
  }

  function test_RestrictedChannelOnlyAcceptsWriters() public {
    address[] memory writers = new address[](1);
    writers[0] = bob;
    vm.prank(alice);
    uint256 id = a2a.createChannel(true, writers);

    vm.prank(bob);
    a2a.post(id, _envelope(200));
    vm.prank(alice); // owner can always post
    a2a.post(id, _envelope(200));

    vm.prank(mallory);
    vm.expectRevert(SodiA2A.NotAWriter.selector);
    a2a.post(id, _envelope(200));

    vm.prank(alice);
    a2a.setWriter(id, bob, false);
    vm.prank(bob);
    vm.expectRevert(SodiA2A.NotAWriter.selector);
    a2a.post(id, _envelope(200));
  }

  function test_UnrestrictedChannelAcceptsAnyone() public {
    vm.prank(alice);
    uint256 id = a2a.createChannel(false, new address[](0));
    vm.prank(mallory);
    a2a.post(id, _envelope(200));
  }

  function test_OnlyOwnerManagesWriters() public {
    vm.prank(alice);
    uint256 id = a2a.createChannel(true, new address[](0));
    vm.prank(mallory);
    vm.expectRevert(SodiA2A.NotChannelOwner.selector);
    a2a.setWriter(id, mallory, true);
  }

  function test_RevertWhen_ChannelUnknown() public {
    vm.expectRevert(SodiA2A.UnknownChannel.selector);
    a2a.post(99, _envelope(200));
  }

  // ---------------------------------------------------------------- gasless posting

  function test_PostFor_AttributesToSigner() public {
    bytes memory e = _envelope(300);
    uint256 deadline = block.timestamp + 60;
    bytes32 sh = keccak256(abi.encode(a2a.POST_TYPEHASH(), alice, 0, keccak256(e), 0, deadline));
    vm.expectEmit(true, true, false, true);
    emit Posted(0, alice, e);
    vm.prank(relayer);
    a2a.postFor(alice, 0, e, deadline, _sign(sh));
  }

  function test_PostFor_CannotBeReplayedOrAltered() public {
    bytes memory e = _envelope(300);
    uint256 deadline = block.timestamp + 60;
    bytes memory sig = _sign(keccak256(abi.encode(a2a.POST_TYPEHASH(), alice, 0, keccak256(e), 0, deadline)));
    a2a.postFor(alice, 0, e, deadline, sig);

    vm.expectRevert(SodiA2A.BadSignature.selector); // nonce moved on
    a2a.postFor(alice, 0, e, deadline, sig);

    bytes memory other = _envelope(301);
    bytes memory sig2 = _sign(keccak256(abi.encode(a2a.POST_TYPEHASH(), alice, 0, keccak256(e), 1, deadline)));
    vm.expectRevert(SodiA2A.BadSignature.selector); // different envelope than signed
    a2a.postFor(alice, 0, other, deadline, sig2);
  }

  function test_PostFor_AcceptsEip7702DelegatedEOA() public {
    // An EOA with an EIP-7702 delegation designator has code, but its own key still signs.
    vm.etch(alice, abi.encodePacked(hex'ef0100', address(0xBEEF)));
    bytes memory e = _envelope(300);
    uint256 deadline = block.timestamp + 60;
    bytes memory sig = _sign(keccak256(abi.encode(a2a.POST_TYPEHASH(), alice, 0, keccak256(e), 0, deadline)));
    vm.expectEmit(true, true, false, true);
    emit Posted(0, alice, e);
    a2a.postFor(alice, 0, e, deadline, sig);
  }

  function test_PostFor_RejectsWrongSigner() public {
    bytes memory e = _envelope(300);
    uint256 deadline = block.timestamp + 60;
    bytes memory sig = _sign(keccak256(abi.encode(a2a.POST_TYPEHASH(), bob, 0, keccak256(e), 0, deadline)));
    vm.expectRevert(SodiA2A.BadSignature.selector);
    a2a.postFor(bob, 0, e, deadline, sig);
  }

  function test_PostFor_RejectsExpired() public {
    bytes memory e = _envelope(300);
    uint256 deadline = block.timestamp - 1;
    bytes memory sig = _sign(keccak256(abi.encode(a2a.POST_TYPEHASH(), alice, 0, keccak256(e), 0, deadline)));
    vm.expectRevert(SodiA2A.Expired.selector);
    a2a.postFor(alice, 0, e, deadline, sig);
  }

  function test_PostFor_RespectsWhitelist() public {
    vm.prank(bob);
    uint256 id = a2a.createChannel(true, new address[](0));
    bytes memory e = _envelope(300);
    uint256 deadline = block.timestamp + 60;
    bytes memory sig = _sign(keccak256(abi.encode(a2a.POST_TYPEHASH(), alice, id, keccak256(e), 0, deadline)));
    vm.expectRevert(SodiA2A.NotAWriter.selector);
    a2a.postFor(alice, id, e, deadline, sig);
  }
}
