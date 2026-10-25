// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test, Vm} from 'forge-std/Test.sol';

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {IERC4626} from '@oz/interfaces/IERC4626.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {Constants} from 'contracts/lib/Constants.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';
import {IState} from 'interfaces/IState.sol';

import {SodiSessionFunder} from '../src/yield/SodiSessionFunder.sol';
import {SodiYieldDepositor} from '../src/yield/SodiYieldDepositor.sol';
import {SodiYieldVault} from '../src/yield/SodiYieldVault.sol';
import {LocalUSDGPool} from './DeployUSDGPool.t.sol';

interface IUSDG3009 {
  function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice The yield pool prototype against a fork of Robinhood Chain mainnet, with the real USDG and
///         the real Steakhouse USDG Morpho vault. The audited pool is deployed unchanged over the yield
///         vault's shares. Proofs are mocked here; packages/rx402/test/e2e-mainnet runs real ones.
///
///         Skipped unless FORK_TESTS=true (it needs the mainnet RPC). Run with --isolate: Morpho Vault V2
///         freezes its total assets for the rest of a transaction once touched, and without --isolate a
///         whole test is one transaction, so time-based interest would never show.
contract YieldPoolForkTest is Test {
  IERC20 internal constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
  IERC4626 internal constant STEAK = IERC4626(0xBeEff033F34C046626B8D0A041844C5d1A5409dd);
  uint256 internal constant PROTOCOL_FEE_BPS = 50; // 0.5% of each session to the depositors
  uint256 internal constant RELAY_FEE_BPS = 20;
  bytes32 internal constant RECEIVE_TYPEHASH =
    keccak256('ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)');

  SodiYieldVault internal vault;
  Entrypoint internal entrypoint;
  IPrivacyPool internal pool;
  SodiYieldDepositor internal depositor;
  SodiSessionFunder internal funder;

  address internal guardian = makeAddr('guardian');
  address internal postman = makeAddr('postman');
  address internal saver = makeAddr('saver');
  address internal relayer = makeAddr('relayer');
  address internal session = makeAddr('session');
  address internal stranger = makeAddr('stranger');

  function setUp() public {
    if (!vm.envOr('FORK_TESTS', false)) vm.skip(true);
    // The public RPC keeps only recent state, so fork at the latest block (or FORK_BLOCK on an archive node).
    uint256 forkBlock = vm.envOr('FORK_BLOCK', uint256(0));
    if (forkBlock == 0) vm.createSelectFork('robinhood');
    else vm.createSelectFork('robinhood', forkBlock);

    vault = new SodiYieldVault(USDG, STEAK, address(this), guardian);
    vm.setEnv('OWNER_ADDRESS', vm.toString(vm.addr(0xA11CE)));
    vm.setEnv('POSTMAN_ADDRESS', vm.toString(postman));
    LocalUSDGPool script = new LocalUSDGPool(address(vault), 0xA11CE); // the audited pool, over syUSDG
    script.setUp();
    script.run();
    entrypoint = script.entrypoint();
    pool = IPrivacyPool(script.pool());
    depositor = new SodiYieldDepositor(entrypoint, vault);
    funder = new SodiSessionFunder(pool, vault, PROTOCOL_FEE_BPS);

    deal(address(USDG), address(this), 1e6);
    USDG.approve(address(vault), 1e6);
    vault.wire(address(pool), address(entrypoint), address(depositor), address(funder), 1e6);
  }

  // ------------------------------------------------------------------ helpers

  struct Dep {
    uint256 commitment;
    uint256 label;
    uint256 shares;
  }

  function _deposit(address who, uint256 assets, uint256 precommitment) internal returns (Dep memory d) {
    deal(address(USDG), who, assets);
    vm.startPrank(who);
    USDG.approve(address(depositor), assets);
    vm.recordLogs();
    d.commitment = depositor.deposit(assets, precommitment);
    vm.stopPrank();
    Vm.Log[] memory logs = vm.getRecordedLogs();
    for (uint256 i; i < logs.length; ++i) {
      if (logs[i].emitter == address(pool) && logs[i].topics[0] == IPrivacyPool.Deposited.selector) {
        (, d.label, d.shares,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
      }
    }
  }

  function _approveRoot(string memory tag) internal {
    vm.prank(postman);
    entrypoint.updateRoot(uint256(keccak256(bytes(tag))) % Constants.SNARK_SCALAR_FIELD, 'QmPrototypeAssociationSetCid0000000000000000');
  }

  function _poolValue() internal view returns (uint256) {
    return vault.convertToAssets(vault.balanceOf(address(pool)));
  }

  function _withdrawal(SodiSessionFunder.FundingData memory data) internal view returns (IPrivacyPool.Withdrawal memory) {
    return IPrivacyPool.Withdrawal({processooor: address(funder), data: abi.encode(data)});
  }

  function _proof(IPrivacyPool.Withdrawal memory w, uint256 shares) internal view returns (ProofLib.WithdrawProof memory p) {
    p.pubSignals[0] = uint256(keccak256('new commitment')) % Constants.SNARK_SCALAR_FIELD;
    p.pubSignals[1] = uint256(keccak256('nullifier')) % Constants.SNARK_SCALAR_FIELD;
    p.pubSignals[2] = shares;
    p.pubSignals[3] = IState(address(pool)).currentRoot();
    p.pubSignals[4] = 1;
    p.pubSignals[5] = entrypoint.latestRoot();
    p.pubSignals[6] = 1;
    p.pubSignals[7] = uint256(keccak256(abi.encode(w, pool.SCOPE()))) % Constants.SNARK_SCALAR_FIELD;
  }

  function _mockVerifiers() internal {
    vm.mockCall(
      address(IState(address(pool)).WITHDRAWAL_VERIFIER()),
      abi.encodeWithSignature('verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[8])'),
      abi.encode(true)
    );
    vm.mockCall(
      address(IState(address(pool)).RAGEQUIT_VERIFIER()),
      abi.encodeWithSignature('verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[4])'),
      abi.encode(true)
    );
  }

  function _ragequit(Dep memory d, uint256 nullifier) internal {
    ProofLib.RagequitProof memory p;
    p.pubSignals = [d.commitment, nullifier, d.shares, d.label];
    depositor.ragequit(p);
  }

  /// @dev Withdraws enough shares for `amount` plus fees, with a 1 basis point margin, as the SDK does.
  function _sharesFor(uint256 amount) internal view returns (uint256) {
    uint256 need = funder.needed(amount, RELAY_FEE_BPS);
    return vault.previewWithdraw(need + (need + 9_999) / 10_000);
  }

  function _fundSession(uint256 amount) internal returns (uint256 shares) {
    shares = _sharesFor(amount);
    IPrivacyPool.Withdrawal memory w = _withdrawal(SodiSessionFunder.FundingData(session, relayer, RELAY_FEE_BPS, amount));
    _mockVerifiers();
    vm.prank(relayer);
    funder.fund(w, _proof(w, shares));
  }

  // ------------------------------------------------------------------ the vault

  function test_DepositsGoThroughTheRouterIntoThePoolAndMorpho() public {
    Dep memory d = _deposit(saver, 1_000e6, 1);
    assertEq(vault.balanceOf(address(pool)), d.shares, 'the shares are in the pool');
    assertEq(vault.balanceOf(saver), 0);
    assertEq(pool.depositors(d.label), address(depositor));
    assertEq(depositor.refundTo(d.label), saver, 'refunds keyed by label');
    assertEq(USDG.balanceOf(address(vault)), 0, 'nothing left idle');
    assertGt(STEAK.balanceOf(address(vault)), 0, 'invested in steakUSDG');
    // About 1:1 with USDG's 6 decimals; the underlying vault rounds its preview down, so a hair more.
    assertApproxEqRel(d.shares, 1_000e6, 0.0001e18);
  }

  function test_SharesNeverExistOutsideThePool() public {
    _deposit(saver, 1_000e6, 1);
    deal(address(USDG), stranger, 10e6);
    vm.startPrank(stranger);
    USDG.approve(address(vault), 10e6);
    vm.expectRevert(SodiYieldVault.NotAllowed.selector);
    vault.deposit(10e6, stranger);
    vm.expectRevert(SodiYieldVault.NotAllowed.selector);
    vault.mint(10e6, stranger);
    vm.stopPrank();
    // Not even the pool can send them to an outsider (e.g. a withdrawal relayed to an ordinary address).
    vm.prank(address(pool));
    vm.expectRevert(SodiYieldVault.SharesStayInThePool.selector);
    vault.transfer(stranger, 1);
    // And the router can't mint to anyone but itself and the other holders.
    vm.prank(address(depositor));
    vm.expectRevert(SodiYieldVault.SharesStayInThePool.selector);
    vault.deposit(0, stranger);
    vm.prank(stranger);
    vm.expectRevert(SodiYieldVault.NotAllowed.selector);
    vault.redeem(1, stranger, address(pool));
  }

  function test_MorphoInterestRaisesTheSharePrice() public {
    _deposit(saver, 1_000e6, 1);
    vm.warp(block.timestamp + 30 days);
    uint256 worth = _poolValue();
    emit log_named_decimal_uint('1000 USDG after 30 days', worth, 6);
    assertGt(worth, 1_000e6);
    assertLt(worth, 1_010e6);
  }

  function test_FeesStreamIntoThePriceOverSevenDays() public {
    _deposit(saver, 1_000e6, 1);
    uint256 start = _poolValue();
    deal(address(USDG), address(this), 70e6);
    USDG.approve(address(vault), 70e6);
    vault.donate(70e6);
    assertApproxEqAbs(_poolValue(), start, 0.01e6, 'nothing released at once');
    assertEq(vault.lockedRemaining(), 70e6);

    vm.warp(block.timestamp + 1 days);
    uint256 day1 = _poolValue() - start;
    emit log_named_decimal_uint('gain after 1 day (fees + interest)', day1, 6);
    // One seventh of the fees (the pool holds 1000 of 1001 shares), plus a day of interest.
    assertApproxEqAbs(day1, (uint256(10e6) * 1_000) / 1_001, 0.2e6);

    vm.warp(block.timestamp + 6 days);
    uint256 week = _poolValue() - start;
    emit log_named_decimal_uint('gain after 7 days (fees + interest)', week, 6);
    assertApproxEqAbs(week, (uint256(70e6) * 1_000) / 1_001, 1e6);
    assertEq(vault.lockedRemaining(), 0);
  }

  function test_TimingAFeeDonationDoesntPay() public {
    _deposit(saver, 1_000e6, 1); // a long-term saver
    // The attacker deposits right before a large fee lands, and ragequits an hour later.
    address attacker = makeAddr('attacker');
    Dep memory a = _deposit(attacker, 10_000e6, 2);
    deal(address(USDG), address(this), 100e6);
    USDG.approve(address(vault), 100e6);
    vault.donate(100e6);
    vm.warp(block.timestamp + 1 hours);
    _mockVerifiers();
    _ragequit(a, 77);

    uint256 back = USDG.balanceOf(attacker);
    emit log_named_decimal_uint('attacker got back for 10000 USDG', back, 6);
    // Released all at once, the attacker would have taken about 90.8 of the 100. Streamed, an hour of it.
    assertLt(back, 10_000e6 + 1e6, 'gains at most about an hour of fees and interest');
    assertGt(back, 10_000e6 - 1e6, 'and gets its deposit back');
  }

  function test_RagequitGoesBackOnlyToTheDepositor() public {
    Dep memory d = _deposit(saver, 100e6, 1);
    _mockVerifiers();
    vm.prank(stranger); // anyone may submit it
    _ragequit(d, 5);
    assertApproxEqAbs(USDG.balanceOf(saver), 100e6, 2);
    assertEq(USDG.balanceOf(stranger), 0);
    assertEq(vault.balanceOf(address(depositor)), 0);
    vm.expectRevert(SodiYieldDepositor.UnknownLabel.selector);
    _ragequit(d, 6);
  }

  function test_RecyclesGaslesslyIntoTheYieldPool() public {
    (address from, uint256 key) = makeAddrAndKey('old session');
    deal(address(USDG), from, 30e6);
    uint256 precommitment = 12_345;
    SodiYieldDepositor.Authorization memory a;
    a.from = from;
    a.value = 30e6;
    a.validBefore = block.timestamp + 300;
    a.nonce = depositor.recycleNonce(precommitment, 0.01e6, relayer);
    bytes32 digest = keccak256(
      abi.encodePacked(
        '\x19\x01',
        IUSDG3009(address(USDG)).DOMAIN_SEPARATOR(),
        keccak256(abi.encode(RECEIVE_TYPEHASH, from, address(depositor), a.value, a.validAfter, a.validBefore, a.nonce))
      )
    );
    (a.v, a.r, a.s) = vm.sign(key, digest);
    vm.prank(relayer);
    vm.recordLogs();
    depositor.recycle(a, precommitment, 0.01e6, relayer);
    uint256 label;
    Vm.Log[] memory logs = vm.getRecordedLogs();
    for (uint256 i; i < logs.length; ++i) {
      if (logs[i].emitter == address(pool) && logs[i].topics[0] == IPrivacyPool.Deposited.selector) (, label,,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
    }
    assertEq(USDG.balanceOf(from), 0);
    assertEq(USDG.balanceOf(relayer), 0.01e6);
    assertEq(depositor.refundTo(label), from);
    assertApproxEqRel(vault.balanceOf(address(pool)), 29.99e6, 0.0001e18);
    assertEq(from.balance, 0, 'the old session never needed gas');
  }

  // ------------------------------------------------------------------ exit

  function test_GuardianExitsToIdleAtOnceAndSessionsKeepWorking() public {
    _deposit(saver, 1_000e6, 1);
    uint256 before = _poolValue();
    vm.prank(stranger);
    vm.expectRevert(SodiYieldVault.NotAllowed.selector);
    vault.exitToIdle(type(uint256).max);

    vm.prank(guardian);
    vault.exitToIdle(type(uint256).max);
    assertEq(STEAK.balanceOf(address(vault)), 0, 'out of Morpho');
    assertTrue(vault.exited());
    assertApproxEqAbs(_poolValue(), before, 2, 'nobody lost anything');
    _deposit(saver, 10e6, 2);
    assertEq(STEAK.balanceOf(address(vault)), 0, 'new deposits stay in plain USDG');

    _approveRoot('after exit');
    _fundSession(10e6);
    assertEq(USDG.balanceOf(session), 10e6, 'sessions are still funded');
  }

  function test_InvestingAgainTakesTwoDaysNotice() public {
    _deposit(saver, 1_000e6, 1);
    vm.prank(guardian);
    vm.expectRevert(SodiYieldVault.NotAllowed.selector);
    vault.proposeUnderlying(STEAK);

    // Can't switch while still invested in the current vault.
    vault.proposeUnderlying(STEAK);
    vm.warp(block.timestamp + 2 days);
    vm.expectRevert(SodiYieldVault.StillInvested.selector);
    vault.acceptUnderlying();

    vm.prank(guardian);
    vault.exitToIdle(type(uint256).max);
    vault.proposeUnderlying(STEAK);
    vm.expectPartialRevert(SodiYieldVault.NoticeNotOver.selector);
    vault.acceptUnderlying();
    vm.warp(block.timestamp + 2 days);
    vault.acceptUnderlying();
    assertFalse(vault.exited());
    assertGt(STEAK.balanceOf(address(vault)), 0, 'invested again');

    // The guardian can stop a proposal during the notice.
    vault.proposeUnderlying(STEAK);
    vm.prank(guardian);
    vault.cancelUnderlying();
    vm.expectRevert(SodiYieldVault.NothingPending.selector);
    vault.acceptUnderlying();
  }

  function test_WiringHappensOnce() public {
    vm.expectRevert(SodiYieldVault.AlreadyWired.selector);
    vault.wire(stranger, stranger, stranger, stranger, 0);
  }

  // ------------------------------------------------------------------ sessions

  function test_FundsAUSDGSessionAndStreamsTheFee() public {
    Dep memory d = _deposit(saver, 1_000e6, 1);
    _approveRoot('root');
    vm.warp(block.timestamp + 7 days);

    uint256 shares = _fundSession(10e6);
    uint256 got = USDG.balanceOf(session);
    emit log_named_decimal_uint('session received (USDG)', got, 6);
    assertEq(got, 10e6, 'exactly the amount the proof states');
    assertEq(USDG.balanceOf(relayer), (10e6 * RELAY_FEE_BPS) / 10_000);
    assertEq(vault.balanceOf(address(pool)), d.shares - shares);
    assertEq(USDG.balanceOf(address(funder)), 0);
    // The protocol fee and the unused margin stream to depositors.
    assertGe(vault.lockedRemaining(), (10e6 * PROTOCOL_FEE_BPS) / 10_000, 'the fee is streaming');
    assertLe(vault.lockedRemaining(), (10e6 * PROTOCOL_FEE_BPS) / 10_000 + 0.002e6, 'plus at most the margin');

    // A week later the fee is in the price of what's left in the pool.
    uint256 left = vault.balanceOf(address(pool));
    uint256 leftValue = vault.convertToAssets(left);
    vm.warp(block.timestamp + 7 days);
    assertGt(vault.convertToAssets(left), leftValue + 0.04e6, 'the fee reached the depositors');
  }

  function test_SessionFeeGoesToTheSinkOnceSet() public {
    address sink = makeAddr('fee sink');
    _deposit(saver, 1_000e6, 1);
    _approveRoot('root');

    // Off by default: nothing reaches the sink.
    _fundSession(10e6);
    assertEq(USDG.balanceOf(sink), 0);

    // Only the deployer, only once.
    vm.prank(saver);
    vm.expectRevert(SodiSessionFunder.NotDeployer.selector);
    funder.setFeeSink(sink, 10);
    vm.expectRevert(SodiSessionFunder.BadFeeSink.selector);
    funder.setFeeSink(sink, 101);
    funder.setFeeSink(sink, 10); // 0.1%
    vm.expectRevert(SodiSessionFunder.FeeSinkAlreadySet.selector);
    funder.setFeeSink(makeAddr('other'), 10);

    // A second session (its own nullifier), sized with the fee included by `needed`.
    address next = makeAddr('next session');
    uint256 shares = _sharesFor(10e6);
    IPrivacyPool.Withdrawal memory w = _withdrawal(SodiSessionFunder.FundingData(next, relayer, RELAY_FEE_BPS, 10e6));
    ProofLib.WithdrawProof memory p = _proof(w, shares);
    p.pubSignals[0] = uint256(keccak256('second commitment')) % Constants.SNARK_SCALAR_FIELD;
    p.pubSignals[1] = uint256(keccak256('second nullifier')) % Constants.SNARK_SCALAR_FIELD;
    _mockVerifiers();
    vm.prank(relayer);
    funder.fund(w, p);
    assertEq(USDG.balanceOf(next), 10e6, 'the session still gets exactly its amount');
    assertEq(USDG.balanceOf(sink), (10e6 * 10) / 10_000, 'the session fee, in USDG, to the sink');
    assertEq(USDG.balanceOf(address(funder)), 0);
  }

  function test_RefusesToPayShortWithoutAMargin() public {
    _deposit(saver, 100e6, 1);
    _approveRoot('root');
    // Shares for the session alone, not its fees: not enough.
    uint256 shares = vault.previewWithdraw(10e6);
    IPrivacyPool.Withdrawal memory w = _withdrawal(SodiSessionFunder.FundingData(session, relayer, RELAY_FEE_BPS, 10e6));
    _mockVerifiers();
    ProofLib.WithdrawProof memory p = _proof(w, shares);
    vm.expectPartialRevert(SodiSessionFunder.NotEnough.selector);
    funder.fund(w, p);
  }

  function test_PriceRiseBetweenProvingAndLandingGoesToDepositors() public {
    _deposit(saver, 100e6, 1);
    _approveRoot('root');
    uint256 shares = _sharesFor(10e6);
    IPrivacyPool.Withdrawal memory w = _withdrawal(SodiSessionFunder.FundingData(session, relayer, RELAY_FEE_BPS, 10e6));
    _mockVerifiers();
    ProofLib.WithdrawProof memory p = _proof(w, shares);
    // The proof sits for a day before it lands: interest raises what the shares are worth.
    vm.warp(block.timestamp + 1 days);
    uint256 worth = vault.convertToAssets(shares);
    vm.prank(relayer);
    funder.fund(w, p);
    assertEq(USDG.balanceOf(session), 10e6, 'still exactly the amount');
    assertEq(USDG.balanceOf(relayer), 0.02e6);
    assertApproxEqAbs(vault.lockedRemaining(), worth - 10e6 - 0.02e6, 2, 'everything else streams to depositors');
  }

  function test_PriceDropBetweenProvingAndLandingRefusesInsteadOfPayingShort() public {
    _deposit(saver, 100e6, 1);
    _approveRoot('root');
    uint256 shares = _sharesFor(10e6);
    IPrivacyPool.Withdrawal memory w = _withdrawal(SodiSessionFunder.FundingData(session, relayer, RELAY_FEE_BPS, 10e6));
    _mockVerifiers();
    ProofLib.WithdrawProof memory p = _proof(w, shares);
    // A 1% loss in the underlying vault before the proof lands, beyond the margin.
    uint256 held = STEAK.balanceOf(address(vault));
    vm.prank(address(vault));
    STEAK.transfer(address(0xdead), held / 100);
    vm.expectPartialRevert(SodiSessionFunder.NotEnough.selector);
    funder.fund(w, p);
    assertEq(USDG.balanceOf(session), 0);
  }

  function test_SubmitterCantChangeTheFundingData() public {
    _deposit(saver, 100e6, 1);
    _approveRoot('root');
    uint256 shares = _sharesFor(9e6);
    IPrivacyPool.Withdrawal memory w = _withdrawal(SodiSessionFunder.FundingData(session, relayer, RELAY_FEE_BPS, 9e6));
    _mockVerifiers();
    ProofLib.WithdrawProof memory p = _proof(w, shares);
    IPrivacyPool.Withdrawal memory stolen = _withdrawal(SodiSessionFunder.FundingData(relayer, relayer, RELAY_FEE_BPS, 9e6));
    vm.expectRevert(IPrivacyPool.ContextMismatch.selector);
    funder.fund(stolen, p);
    IPrivacyPool.Withdrawal memory greedy = _withdrawal(SodiSessionFunder.FundingData(session, relayer, 100, 9e6));
    vm.expectRevert(IPrivacyPool.ContextMismatch.selector);
    funder.fund(greedy, p);
  }

  function test_EnforcesTheLatestApprovalRoot() public {
    _deposit(saver, 100e6, 1);
    _approveRoot('root');
    uint256 shares = vault.previewWithdraw(10e6);
    IPrivacyPool.Withdrawal memory w = _withdrawal(SodiSessionFunder.FundingData(session, relayer, RELAY_FEE_BPS, 9e6));
    _mockVerifiers();
    ProofLib.WithdrawProof memory p = _proof(w, shares);
    _approveRoot('newer root');
    vm.expectRevert(IPrivacyPool.IncorrectASPRoot.selector);
    funder.fund(w, p);
  }

  function test_OnlyProcessesItsOwnWithdrawals() public {
    _deposit(saver, 100e6, 1);
    _approveRoot('root');
    IPrivacyPool.Withdrawal memory w = IPrivacyPool.Withdrawal({processooor: relayer, data: abi.encode(SodiSessionFunder.FundingData(session, relayer, 0, 0))});
    ProofLib.WithdrawProof memory p = _proof(w, 1e6);
    vm.expectRevert(SodiSessionFunder.WrongProcessooor.selector);
    funder.fund(w, p);
    IPrivacyPool.Withdrawal memory mine = _withdrawal(SodiSessionFunder.FundingData(session, relayer, 0, 0));
    _mockVerifiers();
    ProofLib.WithdrawProof memory p2 = _proof(mine, 1e6);
    vm.prank(relayer);
    vm.expectRevert(IPrivacyPool.InvalidProcessooor.selector);
    pool.withdraw(mine, p2);
  }

  function test_CapsTheRelayFee() public {
    _deposit(saver, 100e6, 1);
    _approveRoot('root');
    IPrivacyPool.Withdrawal memory w = _withdrawal(SodiSessionFunder.FundingData(session, relayer, 101, 0));
    ProofLib.WithdrawProof memory p = _proof(w, 1e6);
    vm.expectRevert(SodiSessionFunder.RelayFeeTooHigh.selector);
    funder.fund(w, p);
  }

  function test_RagequitsWhatIsLeftAfterASession() public {
    Dep memory d = _deposit(saver, 100e6, 1);
    _approveRoot('root');
    uint256 spent = _fundSession(10e6); // the note now has a change commitment
    ProofLib.RagequitProof memory p;
    p.pubSignals = [uint256(keccak256('new commitment')) % Constants.SNARK_SCALAR_FIELD, uint256(99), d.shares - spent, d.label];
    depositor.ragequit(p);
    emit log_named_decimal_uint('saver got back after a 10 USDG session', USDG.balanceOf(saver), 6);
    assertApproxEqAbs(USDG.balanceOf(saver), 100e6 - 10e6 - 0.07e6, 0.01e6, 'the rest of the deposit, in USDG');
  }
}
