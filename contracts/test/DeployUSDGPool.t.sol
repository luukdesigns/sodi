// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';

import {ERC20} from '@oz/token/ERC20/ERC20.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {DeployUSDGPool} from '../script/DeployUSDGPool.s.sol';

/// @dev 6-decimal stand-in for USDG.
contract MockUSDG is ERC20 {
  constructor() ERC20('Global Dollar', 'USDG') {}

  function decimals() public pure override returns (uint8) {
    return 6;
  }

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }
}

contract MockEighteenDecimals is ERC20 {
  constructor() ERC20('Wrong', 'WRONG') {}
}

/// @dev Same deployment flow as the testnet script, pointed at a local mock token.
contract LocalUSDGPool is DeployUSDGPool {
  address public immutable ASSET;
  uint256 public immutable DEPLOYER_KEY;

  constructor(address asset, uint256 deployerKey) {
    ASSET = asset;
    DEPLOYER_KEY = deployerKey;
  }

  function setUp() public override {
    _config = PoolConfig({asset: IERC20(ASSET), minimumDepositAmount: 1e6, vettingFeeBPS: 0, maxRelayFeeBPS: 100});
    super.setUp();
  }

  function _startBroadcast() internal override {
    vm.startBroadcast(DEPLOYER_KEY);
  }
}

contract DeployUSDGPoolTest is Test {
  MockUSDG internal usdg;
  address internal owner;
  address internal postman = makeAddr('postman');
  address internal depositor = makeAddr('depositor');

  function setUp() public {
    usdg = new MockUSDG();
    owner = vm.addr(0xA11CE);
    vm.setEnv('OWNER_ADDRESS', vm.toString(owner));
    vm.setEnv('POSTMAN_ADDRESS', vm.toString(postman));
  }

  function _deploy(address asset, uint256 deployerKey) internal returns (LocalUSDGPool script) {
    script = new LocalUSDGPool(asset, deployerKey);
    script.setUp();
    script.run();
  }

  function test_DeploysAndRegistersPool_WhenDeployerIsOwner() public {
    LocalUSDGPool script = _deploy(address(usdg), 0xA11CE);
    Entrypoint entrypoint = script.entrypoint();
    address pool = script.pool();

    (IPrivacyPool registered, uint256 minDeposit, uint256 vettingFee, uint256 maxRelayFee) =
      entrypoint.assetConfig(IERC20(address(usdg)));
    assertEq(address(registered), pool, 'pool not registered');
    assertEq(minDeposit, 1e6);
    assertEq(vettingFee, 0);
    assertEq(maxRelayFee, 100);
    assertEq(address(entrypoint.scopeToPool(IPrivacyPool(pool).SCOPE())), pool);
    assertEq(IPrivacyPool(pool).ASSET(), address(usdg));
  }

  function test_DepositLandsInPool() public {
    LocalUSDGPool script = _deploy(address(usdg), 0xA11CE);
    Entrypoint entrypoint = script.entrypoint();

    usdg.mint(depositor, 5e6);
    vm.startPrank(depositor);
    usdg.approve(address(entrypoint), 5e6);
    entrypoint.deposit(IERC20(address(usdg)), 5e6, 12_345);
    vm.stopPrank();

    assertEq(usdg.balanceOf(script.pool()), 5e6, 'pool should hold the deposit');
    assertEq(usdg.balanceOf(depositor), 0);
  }

  function test_RevertsBelowMinimumDeposit() public {
    LocalUSDGPool script = _deploy(address(usdg), 0xA11CE);
    Entrypoint entrypoint = script.entrypoint();

    usdg.mint(depositor, 5e5);
    vm.startPrank(depositor);
    usdg.approve(address(entrypoint), 5e5);
    vm.expectRevert(IEntrypoint.MinimumDepositAmount.selector);
    entrypoint.deposit(IERC20(address(usdg)), 5e5, 1);
    vm.stopPrank();
  }

  function test_SkipsRegistration_WhenDeployerIsNotOwner() public {
    LocalUSDGPool script = _deploy(address(usdg), 0xB0B);
    (IPrivacyPool registered,,,) = script.entrypoint().assetConfig(IERC20(address(usdg)));
    assertEq(address(registered), address(0));
  }

  function test_RevertsOnWrongDecimals() public {
    MockEighteenDecimals wrong = new MockEighteenDecimals();
    LocalUSDGPool script = new LocalUSDGPool(address(wrong), 1);
    vm.expectRevert(abi.encodeWithSelector(DeployUSDGPool.UnexpectedDecimals.selector, uint8(18)));
    script.setUp();
  }

  function test_RevertsWhenAssetIsNotAContract() public {
    address eoa = makeAddr('not-a-token');
    LocalUSDGPool script = new LocalUSDGPool(eoa, 1);
    vm.expectRevert(abi.encodeWithSelector(DeployUSDGPool.NotAContract.selector, eoa));
    script.setUp();
  }
}
