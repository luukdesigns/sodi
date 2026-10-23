// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from 'forge-std/Script.sol';
import {console} from 'forge-std/console.sol';

import {ERC1967Proxy} from '@oz/proxy/ERC1967/ERC1967Proxy.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@oz/token/ERC20/extensions/IERC20Metadata.sol';

// Upstream Privacy Pools contracts, used unchanged.
import {Entrypoint} from 'contracts/Entrypoint.sol';
import {PrivacyPoolComplex} from 'contracts/implementations/PrivacyPoolComplex.sol';
import {CommitmentVerifier} from 'contracts/verifiers/CommitmentVerifier.sol';
import {WithdrawalVerifier} from 'contracts/verifiers/WithdrawalVerifier.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

/**
 * @title Deploy a USDG Privacy Pool
 * @notice Deploys the audited Privacy Pools verifiers, Entrypoint (behind a UUPS proxy) and a single
 *         USDG pool, then registers the pool with the Entrypoint.
 * @dev Mirrors upstream `script/BaseDeploy.s.sol`, but deploys with plain `new` instead of the CreateX
 *      singleton, which may not exist on Robinhood Chain. Run with `--account <keystore>` or
 *      `--private-key`; the broadcasting wallet becomes the deployer.
 *
 *      Required environment variables:
 *        OWNER_ADDRESS    Receives OWNER_ROLE on the Entrypoint (use a multisig on mainnet)
 *        POSTMAN_ADDRESS  Receives ASP_POSTMAN role, which publishes the approved-deposit root
 */
abstract contract DeployUSDGPool is Script {
  error ChainIdMismatch(uint256 expected, uint256 actual);
  error NotAContract(address target);
  error UnexpectedDecimals(uint8 decimals);

  struct PoolConfig {
    IERC20 asset;
    uint256 minimumDepositAmount;
    uint256 vettingFeeBPS;
    uint256 maxRelayFeeBPS;
  }

  PoolConfig internal _config;
  address public owner;
  address public postman;

  Entrypoint public entrypoint;
  address public withdrawalVerifier;
  address public ragequitVerifier;
  address public pool;

  /// @dev Chain-specific child contracts set `_config` and call `super.setUp()`.
  function setUp() public virtual {
    owner = vm.envAddress('OWNER_ADDRESS');
    postman = vm.envAddress('POSTMAN_ADDRESS');

    // Fail fast if the configured stablecoin is missing or is not a 6-decimal token like USDG.
    address _asset = address(_config.asset);
    if (_asset.code.length == 0) revert NotAContract(_asset);
    uint8 _decimals = IERC20Metadata(_asset).decimals();
    if (_decimals != 6) revert UnexpectedDecimals(_decimals);
  }

  function run() public {
    _startBroadcast();
    // The wallet sending the transactions (from --account / --private-key).
    (, address _broadcaster,) = vm.readCallers();

    withdrawalVerifier = address(new WithdrawalVerifier());
    ragequitVerifier = address(new CommitmentVerifier());

    address _impl = address(new Entrypoint());
    bytes memory _init = abi.encodeCall(Entrypoint.initialize, (owner, postman));
    entrypoint = Entrypoint(payable(address(new ERC1967Proxy(_impl, _init))));

    pool = address(
      new PrivacyPoolComplex(address(entrypoint), withdrawalVerifier, ragequitVerifier, address(_config.asset))
    );

    // Registering requires OWNER_ROLE, so this only succeeds when the deployer is also the owner.
    // Otherwise the owner must call `registerPool` separately with the values logged below.
    if (_broadcaster == owner) {
      entrypoint.registerPool(
        _config.asset,
        IPrivacyPool(pool),
        _config.minimumDepositAmount,
        _config.vettingFeeBPS,
        _config.maxRelayFeeBPS
      );
      console.log('Pool registered with Entrypoint');
    } else {
      console.log('Deployer is not OWNER_ADDRESS: owner must call registerPool');
    }

    vm.stopBroadcast();

    console.log('Chain ID:              %s', block.chainid);
    console.log('WithdrawalVerifier:    %s', withdrawalVerifier);
    console.log('CommitmentVerifier:    %s', ragequitVerifier);
    console.log('Entrypoint impl:       %s', _impl);
    console.log('Entrypoint (proxy):    %s', address(entrypoint));
    console.log('USDG pool:             %s', pool);
    console.log('Pool scope:            %s', IPrivacyPool(pool).SCOPE());
  }

  /// @dev Uses the wallet passed on the command line. Overridable so tests can pick the broadcaster.
  function _startBroadcast() internal virtual {
    vm.startBroadcast();
  }
}

/// @notice Robinhood Chain testnet (chain ID 46630).
contract RobinhoodTestnet is DeployUSDGPool {
  /// @dev USDG on Robinhood Chain testnet. Verify on the explorer before broadcasting.
  address internal constant USDG = 0x7E955252E15c84f5768B83c41a71F9eba181802F;

  function setUp() public override {
    if (block.chainid != 46_630) revert ChainIdMismatch(46_630, block.chainid);

    _config = PoolConfig({
      asset: IERC20(USDG),
      minimumDepositAmount: 1e6, // 1 USDG
      vettingFeeBPS: 0, // no deposit fee on testnet
      maxRelayFeeBPS: 100 // 1% cap on relayer fees
    });

    super.setUp();
  }
}
