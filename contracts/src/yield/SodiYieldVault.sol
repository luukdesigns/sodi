// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {ERC20} from '@oz/token/ERC20/ERC20.sol';
import {ERC4626} from '@oz/token/ERC20/extensions/ERC4626.sol';
import {IERC4626} from '@oz/interfaces/IERC4626.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';

/// @title SodiYieldVault (prototype)
/// @notice An ERC-4626 vault over USDG that puts what it holds into an underlying ERC-4626 vault (the
///         Steakhouse USDG Morpho vault on Robinhood Chain). Its shares are the yield pool's asset, and
///         they exist only inside the pool:
///
///         - Only the deposit router mints them, and it deposits them straight into the pool.
///         - Only the session funder and the router redeem them.
///         - They can only be held by the pool, the Entrypoint, the router and the funder.
///
///         So it isn't a standalone yield product: the only way in is a pool deposit.
///
///         Interest earned by the underlying vault raises the share price continuously. Protocol fees,
///         sent through `donate`, are streamed into the share price linearly over seven days, so a
///         short stay around a fee captures only its proportional share and there is no moment worth
///         timing.
///
///         Exit: the guardian (or owner) can move everything out of the underlying vault into plain USDG
///         at once, which only reduces risk. Putting funds into a vault, the same one again or a new
///         one, takes two days' notice on-chain.
///
///         Shares have USDG's 6 decimals. Against the ERC-4626 donation attack it relies on
///         OpenZeppelin's virtual share and a seed deposit, made at wiring and held by a dead address.
///
///         PROTOTYPE: not audited, not deployed. See docs/yield-pool-design.md.
contract SodiYieldVault is ERC4626 {
  using SafeERC20 for IERC20;

  uint256 public constant STREAM_DURATION = 7 days;
  uint256 public constant NOTICE = 2 days;
  address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

  IERC4626 public underlying;
  address public owner;
  address public guardian;

  /// @notice Fees not yet in the share price, as of `lockedAt`; they release linearly from then.
  uint256 public lockedFees;
  uint256 public lockedAt;

  /// @notice True after an exit: new USDG stays idle until a vault is accepted again.
  bool public exited;
  IERC4626 public pendingUnderlying;
  uint256 public pendingSince;

  address public pool;
  address public entrypoint;
  address public depositor;
  address public funder;

  event Wired(address pool, address entrypoint, address depositor, address funder, uint256 seed);
  event Invested(uint256 assets, uint256 underlyingShares);
  event FeesDonated(uint256 amount, uint256 nowLocked);
  event ExitedToIdle(address indexed by, uint256 underlyingShares, uint256 assets);
  event UnderlyingProposed(address indexed next, uint256 activeAt);
  event UnderlyingCancelled(address indexed next);
  event UnderlyingAccepted(address indexed next);
  event GuardianSet(address guardian);

  error AssetMismatch();
  error NotAllowed();
  error SharesStayInThePool();
  error AlreadyWired();
  error NoticeNotOver(uint256 activeAt);
  error StillInvested();
  error NothingPending();

  modifier onlyOwner() {
    if (msg.sender != owner) revert NotAllowed();
    _;
  }

  constructor(IERC20 usdg, IERC4626 underlying_, address owner_, address guardian_) ERC20('Sodi Yield USDG', 'syUSDG') ERC4626(usdg) {
    if (underlying_.asset() != address(usdg)) revert AssetMismatch();
    underlying = underlying_;
    owner = owner_;
    guardian = guardian_;
  }

  // ------------------------------------------------------------------ wiring

  /// @notice Sets the only addresses that may hold, mint and redeem shares, once, and makes the seed
  ///         deposit (pulled from the owner, minted to a dead address).
  function wire(address pool_, address entrypoint_, address depositor_, address funder_, uint256 seed) external onlyOwner {
    if (pool != address(0)) revert AlreadyWired();
    pool = pool_;
    entrypoint = entrypoint_;
    depositor = depositor_;
    funder = funder_;
    uint256 shares = previewDeposit(seed);
    _deposit(msg.sender, DEAD, seed, shares);
    emit Wired(pool_, entrypoint_, depositor_, funder_, seed);
  }

  function isHolder(address a) public view returns (bool) {
    return a == pool || a == entrypoint || a == depositor || a == funder || a == DEAD;
  }

  // ------------------------------------------------------------------ accounting

  /// @notice Fees donated but not yet released into the share price.
  function lockedRemaining() public view returns (uint256) {
    uint256 elapsed = block.timestamp - lockedAt;
    if (elapsed >= STREAM_DURATION) return 0;
    return (lockedFees * (STREAM_DURATION - elapsed)) / STREAM_DURATION;
  }

  /// @notice USDG held here plus what the underlying shares would redeem for now, minus fees still streaming.
  function totalAssets() public view override returns (uint256) {
    uint256 gross = IERC20(asset()).balanceOf(address(this)) + underlying.previewRedeem(underlying.balanceOf(address(this)));
    uint256 locked = lockedRemaining();
    return gross > locked ? gross - locked : 0;
  }

  /// @notice Adds `amount` USDG of fees, released into the share price over the next seven days
  ///         (together with whatever is still streaming).
  function donate(uint256 amount) external {
    uint256 remaining = lockedRemaining();
    IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
    lockedFees = remaining + amount;
    lockedAt = block.timestamp;
    emit FeesDonated(amount, lockedFees);
    // Not invested here: fees stay as plain USDG until the next deposit invests everything, and
    // sessions redeem from them first. That keeps the session transaction cheaper.
  }

  /// @notice Puts any USDG held here into the underlying vault, unless exited. Anyone may call it.
  function invest() public {
    if (exited) return;
    uint256 idle = IERC20(asset()).balanceOf(address(this));
    if (idle == 0) return;
    IERC20(asset()).forceApprove(address(underlying), idle);
    uint256 got = underlying.deposit(idle, address(this));
    emit Invested(idle, got);
  }

  // ------------------------------------------------------------------ restricted ERC-4626

  function deposit(uint256 assets, address receiver) public override returns (uint256) {
    if (msg.sender != depositor) revert NotAllowed();
    return super.deposit(assets, receiver);
  }

  function mint(uint256 shares, address receiver) public override returns (uint256) {
    if (msg.sender != depositor) revert NotAllowed();
    return super.mint(shares, receiver);
  }

  function withdraw(uint256 assets, address receiver, address owner_) public override returns (uint256) {
    if (msg.sender != funder && msg.sender != depositor) revert NotAllowed();
    return super.withdraw(assets, receiver, owner_);
  }

  function redeem(uint256 shares, address receiver, address owner_) public override returns (uint256) {
    if (msg.sender != funder && msg.sender != depositor) revert NotAllowed();
    return super.redeem(shares, receiver, owner_);
  }

  /// @dev Shares are minted only to, moved only between, and burned only from the allowed holders.
  function _update(address from, address to, uint256 value) internal override {
    if (from != address(0) && !isHolder(from)) revert SharesStayInThePool();
    if (to != address(0) && !isHolder(to)) revert SharesStayInThePool();
    super._update(from, to, value);
  }

  function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
    super._deposit(caller, receiver, assets, shares);
    invest();
  }

  function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares) internal override {
    uint256 idle = IERC20(asset()).balanceOf(address(this));
    if (idle < assets) underlying.withdraw(assets - idle, address(this), address(this));
    super._withdraw(caller, receiver, owner_, assets, shares);
  }

  // ------------------------------------------------------------------ exit

  /// @notice Redeems up to `underlyingShares` from the underlying vault into plain USDG held here, and
  ///         stops investing. Immediate: it can only reduce risk. Repeat it if the underlying vault is
  ///         short of liquidity.
  function exitToIdle(uint256 underlyingShares) external {
    if (msg.sender != guardian && msg.sender != owner) revert NotAllowed();
    exited = true;
    uint256 held = underlying.balanceOf(address(this));
    if (underlyingShares > held) underlyingShares = held;
    uint256 assets = underlyingShares == 0 ? 0 : underlying.redeem(underlyingShares, address(this), address(this));
    emit ExitedToIdle(msg.sender, underlyingShares, assets);
  }

  /// @notice Announces the vault to invest in from two days from now: a new one, or the same one again
  ///         after an exit.
  function proposeUnderlying(IERC4626 next) external onlyOwner {
    if (next.asset() != asset()) revert AssetMismatch();
    pendingUnderlying = next;
    pendingSince = block.timestamp;
    emit UnderlyingProposed(address(next), block.timestamp + NOTICE);
  }

  function cancelUnderlying() external {
    if (msg.sender != guardian && msg.sender != owner) revert NotAllowed();
    emit UnderlyingCancelled(address(pendingUnderlying));
    pendingUnderlying = IERC4626(address(0));
  }

  /// @notice After the notice, switches to the proposed vault and invests. Everything must have left
  ///         the current one first (`exitToIdle`).
  function acceptUnderlying() external onlyOwner {
    IERC4626 next = pendingUnderlying;
    if (address(next) == address(0)) revert NothingPending();
    if (block.timestamp < pendingSince + NOTICE) revert NoticeNotOver(pendingSince + NOTICE);
    if (underlying.balanceOf(address(this)) != 0) revert StillInvested();
    underlying = next;
    pendingUnderlying = IERC4626(address(0));
    exited = false;
    emit UnderlyingAccepted(address(next));
    invest();
  }

  function setGuardian(address guardian_) external onlyOwner {
    guardian = guardian_;
    emit GuardianSet(guardian_);
  }
}
