// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC1967Proxy} from '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';
import {Test} from 'forge-std/Test.sol';

import {ConfidentialDeliverableHook, IKeyRegistry} from '../src/ConfidentialDeliverableHook.sol';
import {AgenticCommerce} from '../src/reference/AgenticCommerce.sol';
import {TestDollar} from '../src/test/TestDollar.sol';

contract Keys is IKeyRegistry {
  mapping(address => bytes32) public encryptionKey;

  function set(address a, bytes32 k) external {
    encryptionKey[a] = k;
  }
}

contract ConfidentialDeliverableHookTest is Test {
  AgenticCommerce internal acp;
  ConfidentialDeliverableHook internal hook;
  TestDollar internal usd;
  Keys internal keys;

  address internal admin = makeAddr('admin');
  address internal treasury = makeAddr('treasury');
  address internal client = makeAddr('client');
  address internal provider = makeAddr('provider');
  address internal evaluator = makeAddr('evaluator');
  address internal stranger = makeAddr('stranger');

  event ConfidentialDeliverable(uint256 indexed jobId, address indexed provider, bytes32 deliverable, bytes envelope);
  event ConfidentialReason(
    uint256 indexed jobId, address indexed evaluator, bytes4 indexed action, bytes32 reason, bytes envelope
  );

  function setUp() public {
    usd = new TestDollar();
    keys = new Keys();
    AgenticCommerce impl = new AgenticCommerce();
    vm.prank(admin);
    acp = AgenticCommerce(
      address(new ERC1967Proxy(address(impl), abi.encodeCall(AgenticCommerce.initialize, (address(usd), treasury))))
    );
    hook = new ConfidentialDeliverableHook(address(acp), keys);
    vm.startPrank(admin);
    acp.grantRole(acp.ADMIN_ROLE(), admin);
    acp.setHookWhitelist(address(hook), true);
    vm.stopPrank();

    keys.set(client, bytes32(uint256(1)));
    keys.set(evaluator, bytes32(uint256(2)));
    usd.mint(client, 100e6);
  }

  function _envelope(uint256 size, uint8 salt) internal pure returns (bytes memory e) {
    e = new bytes(size);
    e[0] = 0xA2;
    e[1] = 0x01;
    e[2] = bytes1(salt);
  }

  function _fundedJob(address hookAddr) internal returns (uint256 id) {
    vm.prank(client);
    id = acp.createJob(provider, evaluator, block.timestamp + 1 days, 'Audit this contract', hookAddr);
    vm.prank(provider);
    acp.setBudget(id, 10e6, '');
    vm.startPrank(client);
    usd.approve(address(acp), 10e6);
    acp.fund(id, '');
    vm.stopPrank();
  }

  // ------------------------------------------------------------------ happy path

  function test_FullLifecycle_DeliverableAndReasonStayConfidential() public {
    uint256 id = _fundedJob(address(hook));
    (address c, address e) = hook.parties(id);
    assertEq(c, client);
    assertEq(e, evaluator);

    bytes memory work = _envelope(600, 1);
    vm.expectEmit(true, true, false, true, address(hook));
    emit ConfidentialDeliverable(id, provider, keccak256(work), work);
    vm.prank(provider);
    acp.submit(id, keccak256(work), work);
    assertEq(uint8(acp.getJob(id).status), uint8(AgenticCommerce.JobStatus.Submitted));

    bytes memory review = _envelope(300, 2);
    vm.expectEmit(true, true, true, true, address(hook));
    emit ConfidentialReason(id, evaluator, hook.COMPLETE(), keccak256(review), review);
    vm.prank(evaluator);
    acp.complete(id, keccak256(review), review);

    assertEq(uint8(acp.getJob(id).status), uint8(AgenticCommerce.JobStatus.Completed));
    assertEq(usd.balanceOf(provider), 10e6, 'provider paid in full (no fees configured)');
  }

  function test_PlainReasonsStillWork() public {
    uint256 id = _fundedJob(address(hook));
    bytes memory work = _envelope(600, 1);
    vm.prank(provider);
    acp.submit(id, keccak256(work), work);
    vm.prank(evaluator);
    acp.reject(id, bytes32('incomplete'), '');
    assertEq(usd.balanceOf(client), 100e6, 'client refunded');
  }

  function test_ConfidentialRejection() public {
    uint256 id = _fundedJob(address(hook));
    bytes memory work = _envelope(600, 1);
    vm.prank(provider);
    acp.submit(id, keccak256(work), work);
    bytes memory why = _envelope(300, 9);
    vm.prank(evaluator);
    acp.reject(id, keccak256(why), why);
    assertEq(uint8(acp.getJob(id).status), uint8(AgenticCommerce.JobStatus.Rejected));
  }

  // ------------------------------------------------------------------ enforcement

  function test_RevertWhen_NoEnvelope() public {
    uint256 id = _fundedJob(address(hook));
    vm.prank(provider);
    vm.expectRevert(ConfidentialDeliverableHook.MissingEnvelope.selector);
    acp.submit(id, keccak256('ipfs://plain-text-report'), '');
  }

  function test_RevertWhen_DeliverableIsPlaintext() public {
    uint256 id = _fundedJob(address(hook));
    bytes memory plain = bytes(
      'Here is the full audit report with every finding in plain text for anyone to read on-chain forever....'
    );
    vm.prank(provider);
    vm.expectRevert(ConfidentialDeliverableHook.InvalidEnvelope.selector);
    acp.submit(id, keccak256(plain), plain);
  }

  function test_RevertWhen_CommitmentDoesNotMatch() public {
    uint256 id = _fundedJob(address(hook));
    bytes memory work = _envelope(600, 1);
    vm.prank(provider);
    vm.expectRevert(ConfidentialDeliverableHook.CommitmentMismatch.selector);
    acp.submit(id, keccak256(_envelope(600, 2)), work);
  }

  function test_RevertWhen_EvaluatorHasNoKey() public {
    keys.set(evaluator, bytes32(0));
    uint256 id = _fundedJob(address(hook));
    bytes memory work = _envelope(600, 1);
    vm.prank(provider);
    vm.expectRevert(abi.encodeWithSelector(ConfidentialDeliverableHook.MissingRecipientKey.selector, evaluator));
    acp.submit(id, keccak256(work), work);
  }

  function test_RevertWhen_ConfidentialReasonMismatched() public {
    uint256 id = _fundedJob(address(hook));
    bytes memory work = _envelope(600, 1);
    vm.prank(provider);
    acp.submit(id, keccak256(work), work);
    vm.prank(evaluator);
    vm.expectRevert(ConfidentialDeliverableHook.CommitmentMismatch.selector);
    acp.complete(id, bytes32('looks good'), _envelope(300, 2));
  }

  function test_OnlyCommerceCanCallHook() public {
    bytes4 createJob = hook.CREATE_JOB();
    bytes4 submit = hook.SUBMIT();
    vm.prank(stranger);
    vm.expectRevert(ConfidentialDeliverableHook.OnlyCommerce.selector);
    hook.afterAction(1, createJob, abi.encode(stranger, stranger, stranger));
    vm.prank(stranger);
    vm.expectRevert(ConfidentialDeliverableHook.OnlyCommerce.selector);
    hook.beforeAction(1, submit, '');
  }

  // ------------------------------------------------------------------ drop-in

  function test_IsAcceptedAsAStandardHook() public view {
    assertTrue(hook.supportsInterface(0x01ffc9a7)); // ERC-165
    assertTrue(acp.whitelistedHooks(address(hook)));
  }

  function test_RefundStillAvailableAfterExpiry() public {
    uint256 id = _fundedJob(address(hook));
    vm.warp(block.timestamp + 2 days);
    acp.claimRefund(id);
    assertEq(usd.balanceOf(client), 100e6);
  }

  function test_JobsWithoutTheHookAreUnaffected() public {
    uint256 id = _fundedJob(address(0));
    vm.prank(provider);
    acp.submit(id, keccak256('public deliverable'), '');
    vm.prank(evaluator);
    acp.complete(id, bytes32(0), '');
    assertEq(usd.balanceOf(provider), 10e6);
  }
}
