// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {IERC4626} from '@oz/interfaces/IERC4626.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {Constants} from 'contracts/lib/Constants.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';
import {IState} from 'interfaces/IState.sol';

import {SodiSessionFunder} from '../src/yield/SodiSessionFunder.sol';
import {SodiYieldVault} from '../src/yield/SodiYieldVault.sol';
import {LocalUSDGPool} from './DeployUSDGPool.t.sol';

/// @notice The yield pool prototype against a fork of Robinhood Chain mainnet, with the real USDG and
///         the real Steakhouse USDG Morpho vault. The audited pool is deployed unchanged over the yield
///         vault's shares. Withdrawal proofs are mocked here; test/e2e runs real ones.
///
///         Skipped unless FORK_TESTS=true (it needs the mainnet RPC). Run with --isolate: Morpho Vault V2
///         freezes its total assets for the rest of a transaction once touched, and without --isolate a
///         whole test is one transaction, so time-based interest would never show.
contract YieldPoolForkTest is Test {
  IERC20 internal constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
  IERC4626 internal constant STEAK = IERC4626(0xBeEff033F34C046626B8D0A041844C5d1A5409dd);
  uint256 internal constant PROTOCOL_FEE_BPS = 50; // 0.5% of each session to the depositors
  uint256 internal constant RELAY_FEE_BPS = 20;

  SodiYieldVault internal vault;
  Entrypoint internal entrypoint;
  IPrivacyPool internal pool;
  SodiSessionFunder internal funder;

  address internal postman = makeAddr('postman');
  address internal saver = makeAddr('saver');
  address internal relayer = makeAddr('relayer');
  address internal session = makeAddr('session');
  address internal dead = address(0xdead);

  function setUp() public {
    if (!vm.envOr('FORK_TESTS', false)) vm.skip(true);
    // The public RPC keeps only recent state, so fork at the latest block (or FORK_BLOCK on an archive node).
    uint256 forkBlock = vm.envOr('FORK_BLOCK', uint256(0));
    if (forkBlock == 0) vm.createSelectFork('robinhood');
    else vm.createSelectFork('robinhood', forkBlock);

    vault = new SodiYieldVault(USDG, STEAK);
    // Seed deposit, never withdrawn: part of the donation-attack defence.
    _fund(address(this), 1e6);
    USDG.approve(address(vault), 1e6);
    vault.deposit(1e6, dead);

    vm.setEnv('OWNER_ADDRESS', vm.toString(vm.addr(0xA11CE)));
    vm.setEnv('POSTMAN_ADDRESS', vm.toString(postman));
    LocalUSDGPool script = new LocalUSDGPool(address(vault), 0xA11CE); // the audited pool, over syUSDG
    script.setUp();
    script.run();
    entrypoint = script.entrypoint();
    pool = IPrivacyPool(script.pool());
    funder = new SodiSessionFunder(pool, vault, PROTOCOL_FEE_BPS);
  }

  function _fund(address to, uint256 amount) internal {
    deal(address(USDG), to, amount);
  }

  // ------------------------------------------------------------------ the vault

  function test_InvestsEverythingInTheMorphoVault() public {
    _fund(saver, 1_000e6);
    vm.startPrank(saver);
    USDG.approve(address(vault), 1_000e6);
    uint256 shares = vault.deposit(1_000e6, saver);
    vm.stopPrank();

    assertEq(USDG.balanceOf(address(vault)), 0, 'nothing left idle');
    assertGt(STEAK.balanceOf(address(vault)), 0, 'holds steakUSDG');
    assertApproxEqAbs(vault.convertToAssets(shares), 1_000e6, 2, 'worth what was deposited');
    // About 1:1 with USDG's 6 decimals; the underlying vault rounds its preview down, so a hair more.
    assertApproxEqRel(shares, 1_000e6, 0.0001e18, 'shares start at about 1:1');
  }

  function test_MorphoInterestRaisesTheSharePrice() public {
    _fund(saver, 1_000e6);
    vm.startPrank(saver);
    USDG.approve(address(vault), 1_000e6);
    uint256 shares = vault.deposit(1_000e6, saver);
    vm.stopPrank();

    vm.warp(block.timestamp + 30 days);
    uint256 worth = vault.convertToAssets(shares);
    emit log_named_decimal_uint('worth after 30 days (USDG)', worth, 6);
    assertGt(worth, 1_000e6, 'earned interest');
    assertLt(worth, 1_010e6, 'at a plausible rate (< ~12% a year)');

    vm.prank(saver);
    uint256 out = vault.redeem(shares, saver, saver);
    assertEq(USDG.balanceOf(saver), out);
    assertGt(out, 1_000e6, 'redeems with the interest');
  }

  function test_DonationsGoToHoldersOnly() public {
    _fund(saver, 1_000e6);
    vm.startPrank(saver);
    USDG.approve(address(vault), 1_000e6);
    uint256 shares = vault.deposit(1_000e6, saver);
    vm.stopPrank();
    uint256 steakPrice = STEAK.convertToAssets(1e18);

    _fund(address(this), 10e6);
    USDG.transfer(address(vault), 10e6);
    // The saver holds 1000 of the 1001 shares; the seed holds the rest.
    uint256 expected = 1_000e6;
    expected += (uint256(10e6) * 1_000) / 1_001;
    assertApproxEqAbs(vault.convertToAssets(shares), expected, 2);
    assertEq(STEAK.convertToAssets(1e18), steakPrice, 'the Morpho vault is untouched');
    vault.invest();
    assertEq(USDG.balanceOf(address(vault)), 0);
  }

  function test_DonationAttackOnANewDepositorFails() public {
    // The attacker gets in first after the seed, then donates heavily to inflate the price.
    address attacker = makeAddr('attacker');
    _fund(attacker, 10_001e6);
    vm.startPrank(attacker);
    USDG.approve(address(vault), 1);
    uint256 attackerShares = vault.deposit(1, attacker);
    USDG.transfer(address(vault), 10_000e6);
    vm.stopPrank();

    _fund(saver, 1_000e6);
    vm.startPrank(saver);
    USDG.approve(address(vault), 1_000e6);
    uint256 shares = vault.deposit(1_000e6, saver);
    vm.stopPrank();

    assertGt(shares, 0);
    assertGe(vault.convertToAssets(shares), 1_000e6 - 0.02e6, 'the victim loses at most rounding');
    assertLt(vault.convertToAssets(attackerShares), 10_000e6, 'the attacker loses most of the donation');
  }

  // ------------------------------------------------------------------ sessions

  struct Deposited {
    uint256 shares;
    uint256 label;
  }

  function _depositIntoPool(uint256 assets) internal returns (Deposited memory d) {
    _fund(saver, assets);
    vm.startPrank(saver);
    USDG.approve(address(vault), assets);
    d.shares = vault.deposit(assets, saver);
    vault.approve(address(entrypoint), d.shares);
    entrypoint.deposit(IERC20(address(vault)), d.shares, uint256(keccak256('precommitment')) % Constants.SNARK_SCALAR_FIELD);
    vm.stopPrank();
    vm.prank(postman);
    entrypoint.updateRoot(uint256(keccak256('asp root')) % Constants.SNARK_SCALAR_FIELD, 'QmPrototypeAssociationSetCid0000000000000000');
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

  function _mockVerifier() internal {
    vm.mockCall(
      address(IState(address(pool)).WITHDRAWAL_VERIFIER()),
      abi.encodeWithSignature('verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[8])'),
      abi.encode(true)
    );
  }

  function test_FundsAUSDGSessionFromAShareWithdrawal() public {
    Deposited memory dep = _depositIntoPool(1_000e6);
    assertEq(vault.balanceOf(address(pool)), dep.shares, 'the pool holds yield shares');
    vm.warp(block.timestamp + 7 days); // interest accrues while the deposit sits in the pool

    uint256 sessionShares = vault.previewWithdraw(10e6);
    SodiSessionFunder.FundingData memory data = SodiSessionFunder.FundingData(session, relayer, RELAY_FEE_BPS, 9.9e6);
    IPrivacyPool.Withdrawal memory w = _withdrawal(data);
    _mockVerifier();
    uint256 priceBefore = vault.convertToAssets(1e6);

    vm.prank(relayer);
    funder.fund(w, _proof(w, sessionShares));

    uint256 assets = USDG.balanceOf(session) + USDG.balanceOf(relayer) + (10e6 * PROTOCOL_FEE_BPS) / 10_000;
    emit log_named_decimal_uint('session received (USDG)', USDG.balanceOf(session), 6);
    assertApproxEqAbs(assets, 10e6, 3, 'shares redeemed for the USDG they were worth');
    assertEq(USDG.balanceOf(relayer), (USDG.balanceOf(session) * RELAY_FEE_BPS) / (10_000 - PROTOCOL_FEE_BPS - RELAY_FEE_BPS), 'relayer fee');
    assertEq(vault.balanceOf(address(pool)), dep.shares - sessionShares, 'shares left the pool');
    assertEq(vault.balanceOf(address(funder)), 0);
    assertEq(USDG.balanceOf(address(funder)), 0, 'nothing left in the funder');
    assertGt(vault.convertToAssets(1e6), priceBefore, 'the protocol fee raised the share price');
  }

  function test_RefusesLessThanTheMinimum() public {
    Deposited memory dep = _depositIntoPool(100e6);
    dep;
    uint256 sessionShares = vault.previewWithdraw(10e6);
    IPrivacyPool.Withdrawal memory w = _withdrawal(SodiSessionFunder.FundingData(session, relayer, RELAY_FEE_BPS, 10e6));
    _mockVerifier();
    ProofLib.WithdrawProof memory p = _proof(w, sessionShares);
    vm.expectPartialRevert(SodiSessionFunder.BelowMinimum.selector);
    funder.fund(w, p);
  }

  function test_SubmitterCantChangeTheFundingData() public {
    _depositIntoPool(100e6);
    uint256 sessionShares = vault.previewWithdraw(10e6);
    IPrivacyPool.Withdrawal memory w = _withdrawal(SodiSessionFunder.FundingData(session, relayer, RELAY_FEE_BPS, 9e6));
    _mockVerifier();
    ProofLib.WithdrawProof memory p = _proof(w, sessionShares);
    // Redirect the session or raise the fee: the proof's context no longer matches.
    IPrivacyPool.Withdrawal memory stolen = _withdrawal(SodiSessionFunder.FundingData(relayer, relayer, RELAY_FEE_BPS, 9e6));
    vm.expectRevert(IPrivacyPool.ContextMismatch.selector);
    funder.fund(stolen, p);
    IPrivacyPool.Withdrawal memory greedy = _withdrawal(SodiSessionFunder.FundingData(session, relayer, 100, 9e6));
    vm.expectRevert(IPrivacyPool.ContextMismatch.selector);
    funder.fund(greedy, p);
  }

  function test_EnforcesTheLatestApprovalRoot() public {
    _depositIntoPool(100e6);
    uint256 sessionShares = vault.previewWithdraw(10e6);
    IPrivacyPool.Withdrawal memory w = _withdrawal(SodiSessionFunder.FundingData(session, relayer, RELAY_FEE_BPS, 9e6));
    _mockVerifier();
    ProofLib.WithdrawProof memory p = _proof(w, sessionShares);
    vm.prank(postman);
    entrypoint.updateRoot(uint256(keccak256('newer root')) % Constants.SNARK_SCALAR_FIELD, 'QmPrototypeAssociationSetCid1111111111111111');
    vm.expectRevert(IPrivacyPool.IncorrectASPRoot.selector);
    funder.fund(w, p);
  }

  function test_OnlyProcessesItsOwnWithdrawals() public {
    _depositIntoPool(100e6);
    IPrivacyPool.Withdrawal memory w = IPrivacyPool.Withdrawal({processooor: relayer, data: abi.encode(SodiSessionFunder.FundingData(session, relayer, 0, 0))});
    ProofLib.WithdrawProof memory p = _proof(w, 1e6);
    vm.expectRevert(SodiSessionFunder.WrongProcessooor.selector);
    funder.fund(w, p);
    // And nobody else can process a withdrawal made out to the funder.
    IPrivacyPool.Withdrawal memory mine = _withdrawal(SodiSessionFunder.FundingData(session, relayer, 0, 0));
    _mockVerifier();
    ProofLib.WithdrawProof memory p2 = _proof(mine, 1e6);
    vm.prank(relayer);
    vm.expectRevert(IPrivacyPool.InvalidProcessooor.selector);
    pool.withdraw(mine, p2);
  }

  function test_CapsTheRelayFee() public {
    _depositIntoPool(100e6);
    IPrivacyPool.Withdrawal memory w = _withdrawal(SodiSessionFunder.FundingData(session, relayer, 101, 0));
    ProofLib.WithdrawProof memory p = _proof(w, 1e6);
    vm.expectRevert(SodiSessionFunder.RelayFeeTooHigh.selector);
    funder.fund(w, p);
  }
}
