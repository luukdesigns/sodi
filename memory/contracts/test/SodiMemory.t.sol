// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';

import {SodiMemory} from '../src/SodiMemory.sol';

contract SodiMemoryTest is Test {
  SodiMemory internal mem;
  uint256 internal agentKey = 0xA6E47;
  address internal agent;
  address internal relayer = makeAddr('relayer');
  bytes32 internal constant NS = keccak256('portfolio-notes');

  event MemoryCommitted(
    address indexed agent, bytes32 indexed namespace, uint64 version, bytes32 contentHash, bytes envelope, string location
  );

  function setUp() public {
    mem = new SodiMemory();
    agent = vm.addr(agentKey);
  }

  function _envelope(uint256 size, uint8 salt) internal pure returns (bytes memory e) {
    e = new bytes(size);
    e[0] = 0xA2;
    e[1] = 0x01;
    e[2] = bytes1(salt);
  }

  function _sign(bytes32 ns, uint64 v, bytes32 hash, string memory loc, uint256 deadline)
    internal
    view
    returns (bytes memory)
  {
    bytes32 sh = keccak256(
      abi.encode(mem.COMMIT_TYPEHASH(), agent, ns, v, hash, keccak256(bytes(loc)), mem.nonces(agent), deadline)
    );
    (uint8 vv, bytes32 r, bytes32 s) =
      vm.sign(agentKey, keccak256(abi.encodePacked('\x19\x01', mem.domainSeparator(), sh)));
    return abi.encodePacked(r, s, vv);
  }

  function test_InlineWritesAreVersioned() public {
    bytes memory e1 = _envelope(300, 1);
    vm.expectEmit(true, true, false, true);
    emit MemoryCommitted(agent, NS, 1, keccak256(e1), e1, '');
    vm.prank(agent);
    mem.commitInline(NS, 0, e1);

    bytes memory e2 = _envelope(300, 2);
    vm.prank(agent);
    mem.commitInline(NS, 1, e2);
    (uint64 v, bytes32 h) = mem.heads(agent, NS);
    assertEq(v, 2);
    assertEq(h, keccak256(e2));
  }

  function test_RevertWhen_StaleVersion() public {
    vm.prank(agent);
    mem.commitInline(NS, 0, _envelope(300, 1));
    // A second copy of the agent that still thinks the slot is empty must not overwrite it.
    vm.prank(agent);
    vm.expectRevert(abi.encodeWithSelector(SodiMemory.VersionConflict.selector, uint64(1)));
    mem.commitInline(NS, 0, _envelope(300, 2));
  }

  function test_PointerWrites() public {
    bytes32 h = keccak256('stored elsewhere');
    vm.expectEmit(true, true, false, true);
    emit MemoryCommitted(agent, NS, 1, h, '', 'ipfs://bafy');
    vm.prank(agent);
    mem.commitPointer(NS, 0, h, 'ipfs://bafy');
  }

  function test_RevertWhen_NoEnvelopeAndNoLocation() public {
    vm.prank(agent);
    vm.expectRevert(SodiMemory.MissingLocation.selector);
    mem.commitPointer(NS, 0, keccak256('x'), '');
  }

  function test_RevertWhen_InlineIsPlaintext() public {
    vm.prank(agent);
    vm.expectRevert(SodiMemory.InvalidEnvelope.selector);
    mem.commitInline(NS, 0, bytes('my api key is sk-live-...'));
  }

  function test_SlotsAreIsolatedPerAgent() public {
    vm.prank(agent);
    mem.commitInline(NS, 0, _envelope(300, 1));
    address other = makeAddr('other');
    vm.prank(other);
    mem.commitInline(NS, 0, _envelope(300, 1)); // other agent's own slot starts at 0
    (uint64 v,) = mem.heads(other, NS);
    assertEq(v, 1);
  }

  function test_GaslessInlineCommit() public {
    bytes memory e = _envelope(300, 1);
    uint256 deadline = block.timestamp + 60;
    bytes memory sig = _sign(NS, 0, keccak256(e), '', deadline);
    vm.prank(relayer);
    mem.commitFor(agent, NS, 0, e, bytes32(0), '', deadline, sig);
    (uint64 v,) = mem.heads(agent, NS);
    assertEq(v, 1);
  }

  function test_GaslessPointerCommit() public {
    bytes32 h = keccak256('blob');
    uint256 deadline = block.timestamp + 60;
    bytes memory sig = _sign(NS, 0, h, 's3://bucket/blob', deadline);
    mem.commitFor(agent, NS, 0, '', h, 's3://bucket/blob', deadline, sig);
    (, bytes32 head) = mem.heads(agent, NS);
    assertEq(head, h);
  }

  function test_GaslessCommitCannotBeRedirected() public {
    bytes32 h = keccak256('blob');
    uint256 deadline = block.timestamp + 60;
    bytes memory sig = _sign(NS, 0, h, 'ipfs://honest', deadline);
    vm.expectRevert(SodiMemory.BadSignature.selector); // relayer swaps the location
    mem.commitFor(agent, NS, 0, '', h, 'ipfs://evil', deadline, sig);
  }

  function test_GaslessCommitWorksForEip7702Accounts() public {
    vm.etch(agent, abi.encodePacked(hex'ef0100', address(0xBEEF)));
    bytes memory e = _envelope(300, 1);
    uint256 deadline = block.timestamp + 60;
    bytes memory sig = _sign(NS, 0, keccak256(e), '', deadline);
    mem.commitFor(agent, NS, 0, e, bytes32(0), '', deadline, sig);
  }
}
