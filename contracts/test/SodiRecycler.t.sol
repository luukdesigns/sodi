// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test, Vm} from 'forge-std/Test.sol';

import {ERC20} from '@oz/token/ERC20/ERC20.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {ECDSA} from '@oz/utils/cryptography/ECDSA.sol';
import {EIP712} from '@oz/utils/cryptography/EIP712.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';
import {IState} from 'interfaces/IState.sol';

import {SodiRecycler} from '../src/SodiRecycler.sol';
import {LocalUSDGPool} from './DeployUSDGPool.t.sol';

/// @dev 6-decimal dollar with EIP-3009, like USDG.
contract Dollar3009 is ERC20, EIP712 {
  bytes32 public constant TRANSFER_TYPEHASH = keccak256(
    'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'
  );
  bytes32 public constant RECEIVE_TYPEHASH = keccak256(
    'ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'
  );
  mapping(address => mapping(bytes32 => bool)) public authorizationState;

  error AuthorizationUsedAlready();
  error AuthorizationExpired();
  error InvalidSignature();
  error CallerMustBePayee();

  constructor() ERC20('Global Dollar', 'USDG') EIP712('Global Dollar', '1') {}

  function decimals() public pure override returns (uint8) {
    return 6;
  }

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  function digest(bytes32 typehash, address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
    public
    view
    returns (bytes32)
  {
    return _hashTypedDataV4(keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce)));
  }

  function _use(bytes32 typehash, address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)
    internal
  {
    if (block.timestamp <= validAfter || block.timestamp >= validBefore) revert AuthorizationExpired();
    if (authorizationState[from][nonce]) revert AuthorizationUsedAlready();
    if (ECDSA.recover(digest(typehash, from, to, value, validAfter, validBefore, nonce), v, r, s) != from) revert InvalidSignature();
    authorizationState[from][nonce] = true;
    _transfer(from, to, value);
  }

  function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)
    external
  {
    _use(TRANSFER_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s);
  }

  function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)
    external
  {
    if (msg.sender != to) revert CallerMustBePayee();
    _use(RECEIVE_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s);
  }
}

contract SodiRecyclerTest is Test {
  Dollar3009 internal usdg;
  Entrypoint internal entrypoint;
  IPrivacyPool internal pool;
  SodiRecycler internal recycler;

  uint256 internal sessionKey = 0x5E5510;
  address internal session;
  address internal relayer = makeAddr('relayer');
  address internal attacker = makeAddr('attacker');
  uint256 internal constant PRECOMMITMENT = 0xC0FFEE;

  function setUp() public {
    usdg = new Dollar3009();
    vm.setEnv('OWNER_ADDRESS', vm.toString(vm.addr(0xA11CE)));
    vm.setEnv('POSTMAN_ADDRESS', vm.toString(makeAddr('postman')));
    LocalUSDGPool script = new LocalUSDGPool(address(usdg), 0xA11CE); // minimum deposit 1 USDG
    script.setUp();
    script.run();
    entrypoint = script.entrypoint();
    pool = IPrivacyPool(script.pool());
    recycler = new SodiRecycler(IEntrypoint(address(entrypoint)), IERC20(address(usdg)));
    session = vm.addr(sessionKey);
    usdg.mint(session, 3e6);
    vm.warp(1_800_000_000);
  }

  function _auth(uint256 value, uint256 precommitment, uint256 fee, address feeRecipient)
    internal
    view
    returns (SodiRecycler.Authorization memory a)
  {
    a.from = session;
    a.value = value;
    a.validAfter = 0;
    a.validBefore = block.timestamp + 300;
    a.nonce = recycler.recycleNonce(precommitment, fee, feeRecipient);
    (a.v, a.r, a.s) = vm.sign(
      sessionKey, usdg.digest(usdg.RECEIVE_TYPEHASH(), session, address(recycler), value, a.validAfter, a.validBefore, a.nonce)
    );
  }

  function _recycle() internal returns (uint256 commitment, uint256 label) {
    SodiRecycler.Authorization memory a = _auth(3e6, PRECOMMITMENT, 10_000, relayer);
    vm.recordLogs();
    vm.prank(relayer);
    commitment = recycler.recycle(a, PRECOMMITMENT, 10_000, relayer);
    Vm.Log[] memory logs = vm.getRecordedLogs();
    for (uint256 i; i < logs.length; ++i) {
      if (logs[i].emitter == address(pool) && logs[i].topics[0] == IPrivacyPool.Deposited.selector) {
        (, label,,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
      }
    }
  }

  function test_RecyclesIntoThePoolWithoutGasAtTheAddress() public {
    (uint256 commitment, uint256 label) = _recycle();
    assertEq(usdg.balanceOf(session), 0, 'session emptied');
    assertEq(usdg.balanceOf(address(pool)), 3e6 - 10_000, 'deposited minus fee');
    assertEq(usdg.balanceOf(relayer), 10_000, 'fee paid to submitter');
    assertEq(usdg.balanceOf(address(recycler)), 0, 'nothing left behind');
    assertEq(recycler.refundTo(commitment), session);
    assertEq(pool.depositors(label), address(recycler));
    assertEq(session.balance, 0, 'session never needed gas');
  }

  function test_FrontRunnerCantChooseTheDeposit() public {
    SodiRecycler.Authorization memory a = _auth(3e6, PRECOMMITMENT, 0, address(0));
    // Same signature, another precommitment: the nonce no longer matches.
    vm.prank(attacker);
    vm.expectRevert(SodiRecycler.NonceMismatch.selector);
    recycler.recycle(a, 0xBAD, 0, address(0));
    // Recomputing the nonce for the attacker's precommitment breaks the signature.
    a.nonce = recycler.recycleNonce(0xBAD, 0, address(0));
    vm.prank(attacker);
    vm.expectRevert(Dollar3009.InvalidSignature.selector);
    recycler.recycle(a, 0xBAD, 0, address(0));
  }

  function test_SubmitterCantRaiseItsFee() public {
    SodiRecycler.Authorization memory a = _auth(3e6, PRECOMMITMENT, 10_000, relayer);
    vm.expectRevert(SodiRecycler.NonceMismatch.selector);
    recycler.recycle(a, PRECOMMITMENT, 500_000, relayer);
    vm.expectRevert(SodiRecycler.NonceMismatch.selector);
    recycler.recycle(a, PRECOMMITMENT, 10_000, attacker);
  }

  function test_FundsCantBeMovedOutsideTheRecycler() public {
    SodiRecycler.Authorization memory a = _auth(3e6, PRECOMMITMENT, 0, address(0));
    vm.prank(attacker);
    vm.expectRevert(Dollar3009.CallerMustBePayee.selector);
    usdg.receiveWithAuthorization(session, address(recycler), a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
    // The receive signature isn't valid as a transfer.
    vm.expectRevert(Dollar3009.InvalidSignature.selector);
    usdg.transferWithAuthorization(session, address(recycler), a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
  }

  function test_RejectsReplaysFeesAndDustBelowThePoolMinimum() public {
    SodiRecycler.Authorization memory a = _auth(3e6, PRECOMMITMENT, 0, address(0));
    recycler.recycle(a, PRECOMMITMENT, 0, address(0));
    vm.expectRevert(Dollar3009.AuthorizationUsedAlready.selector);
    recycler.recycle(a, PRECOMMITMENT, 0, address(0));

    usdg.mint(session, 3e6);
    SodiRecycler.Authorization memory greedy = _auth(3e6, 7, 3e6, relayer);
    vm.expectRevert(SodiRecycler.FeeTooHigh.selector);
    recycler.recycle(greedy, 7, 3e6, relayer);

    SodiRecycler.Authorization memory dust = _auth(5e5, 8, 0, address(0));
    vm.expectRevert(IEntrypoint.MinimumDepositAmount.selector);
    recycler.recycle(dust, 8, 0, address(0));
    assertEq(usdg.balanceOf(session), 3e6, 'a failed recycle leaves the funds');
  }

  function _ragequitProof(uint256 commitment, uint256 label, uint256 value) internal pure returns (ProofLib.RagequitProof memory p) {
    p.pubSignals = [commitment, uint256(0xDEAD), value, label];
  }

  function test_RagequitSendsFundsBackToWhereTheyCameFrom() public {
    (uint256 commitment, uint256 label) = _recycle();
    // The ragequit circuit isn't run here; its verifier is mocked to accept.
    vm.mockCall(
      address(IState(address(pool)).RAGEQUIT_VERIFIER()),
      abi.encodeWithSignature('verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[4])'),
      abi.encode(true)
    );
    ProofLib.RagequitProof memory proof = _ragequitProof(commitment, label, 3e6 - 10_000);

    // The original address can't ragequit directly: the recycler is the depositor.
    vm.prank(session);
    vm.expectRevert(IPrivacyPool.OnlyOriginalDepositor.selector);
    pool.ragequit(proof);

    // Anyone may submit it through the recycler; the funds can only go back to the session.
    vm.prank(attacker);
    recycler.ragequit(proof);
    assertEq(usdg.balanceOf(session), 3e6 - 10_000);
    assertEq(usdg.balanceOf(attacker), 0);
    assertEq(usdg.balanceOf(address(recycler)), 0);

    vm.expectRevert(SodiRecycler.UnknownCommitment.selector);
    recycler.ragequit(proof);
  }

  function test_RagequitRefusesDepositsItDidntMake() public {
    ProofLib.RagequitProof memory proof = _ragequitProof(123, 456, 1e6);
    vm.expectRevert(SodiRecycler.UnknownCommitment.selector);
    recycler.ragequit(proof);
  }
}
