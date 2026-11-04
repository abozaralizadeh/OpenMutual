// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice The shared pool. Backers hold shares, and the share price rises or
/// falls with what is left of premiums after payouts.
///
/// Money in the pool is split like this:
///   balance = backers' capital (totalAssets) + premiums not yet earned
///   backers' capital = locked for active covers + free
/// Every active cover has its full payout covered by its premium plus locked
/// capital, so the pool can always pay what it has promised.
contract MutualPool is ERC4626, Ownable {
    using SafeERC20 for IERC20;

    enum CoverEnd {
        Expired,
        PaidOut,
        Refunded
    }

    struct WithdrawalRequest {
        address backer;
        uint64 readyAt;
        uint256 shares;
    }

    uint256 public constant MAX_WITHDRAWAL_WAIT = 30 days;
    uint256 public constant MAX_MEMBER_REBATE_BPS = 5_000;

    address public coverBook;
    address public guardian;
    bool public paused;

    uint256 public lockedCapital;
    uint256 public unearnedPremiums;
    uint256 public poolCap;
    uint256 public withdrawalWait;
    uint256 public memberRebateBps;

    WithdrawalRequest[] public withdrawalRequests;
    uint256 public nextWithdrawal;

    event CoverBookSet(address coverBook);
    event GuardianSet(address guardian);
    event PausedSet(bool paused);
    event PoolCapSet(uint256 poolCap);
    event WithdrawalWaitSet(uint256 withdrawalWait);
    event MemberRebateSet(uint256 memberRebateBps);
    event CapitalLocked(uint256 premium, uint256 capital);
    event CapitalReleased(uint256 premium, uint256 capital, CoverEnd end, uint256 paidToHolder);
    event WithdrawalRequested(uint256 indexed id, address indexed backer, uint256 shares, uint256 readyAt);
    event WithdrawalPaid(uint256 indexed id, address indexed backer, uint256 shares, uint256 assets, bool finished);

    error NotCoverBook();
    error NotGuardian();
    error CoverBookAlreadySet();
    error NotEnoughFreeCapital();
    error SharesCannotBeTransferred();
    error ZeroShares();
    error ValueTooHigh();
    error BadCover();

    modifier onlyCoverBook() {
        if (msg.sender != coverBook) revert NotCoverBook();
        _;
    }

    constructor(IERC20 asset_, address owner_, address guardian_, uint256 poolCap_, uint256 withdrawalWait_, uint256 memberRebateBps_)
        ERC20("OpenMutual pool share (test)", "tOMS")
        ERC4626(asset_)
        Ownable(owner_)
    {
        if (withdrawalWait_ > MAX_WITHDRAWAL_WAIT || memberRebateBps_ > MAX_MEMBER_REBATE_BPS) revert ValueTooHigh();
        guardian = guardian_;
        poolCap = poolCap_;
        withdrawalWait = withdrawalWait_;
        memberRebateBps = memberRebateBps_;
    }

    // Settings

    /// @dev Can only be set once. Contracts aren't upgradable, a new CoverBook means a new pool.
    function setCoverBook(address coverBook_) external onlyOwner {
        if (coverBook != address(0)) revert CoverBookAlreadySet();
        coverBook = coverBook_;
        emit CoverBookSet(coverBook_);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function setPoolCap(uint256 poolCap_) external onlyOwner {
        poolCap = poolCap_;
        emit PoolCapSet(poolCap_);
    }

    function setWithdrawalWait(uint256 withdrawalWait_) external onlyOwner {
        if (withdrawalWait_ > MAX_WITHDRAWAL_WAIT) revert ValueTooHigh();
        withdrawalWait = withdrawalWait_;
        emit WithdrawalWaitSet(withdrawalWait_);
    }

    function setMemberRebateBps(uint256 memberRebateBps_) external onlyOwner {
        if (memberRebateBps_ > MAX_MEMBER_REBATE_BPS) revert ValueTooHigh();
        memberRebateBps = memberRebateBps_;
        emit MemberRebateSet(memberRebateBps_);
    }

    /// @notice Stops new deposits and new covers. Payouts and withdrawals stay open.
    function setPaused(bool paused_) external {
        if (msg.sender != guardian) revert NotGuardian();
        paused = paused_;
        emit PausedSet(paused_);
    }

    // Accounting

    /// @notice Backers' capital. Premiums count only once they've been earned.
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) - unearnedPremiums;
    }

    /// @notice Capital that isn't backing an active cover.
    function freeCapital() public view returns (uint256) {
        uint256 assets = totalAssets();
        return assets > lockedCapital ? assets - lockedCapital : 0;
    }

    function pendingWithdrawals() external view returns (uint256) {
        return withdrawalRequests.length - nextWithdrawal;
    }

    function withdrawalCount() external view returns (uint256) {
        return withdrawalRequests.length;
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }

    // Deposits

    function maxDeposit(address) public view override returns (uint256) {
        if (paused) return 0;
        uint256 assets = totalAssets();
        return poolCap > assets ? poolCap - assets : 0;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return previewDeposit(maxDeposit(receiver));
    }

    // Withdrawals only go through the queue, so the plain ERC-4626 exits are closed.

    function maxWithdraw(address) public pure override returns (uint256) {
        return 0;
    }

    function maxRedeem(address) public pure override returns (uint256) {
        return 0;
    }

    /// @notice Starts the wait. Shares stay in the pool and keep sharing gains
    /// and losses until they're paid. A request can't be cancelled, so nobody
    /// can keep a rolling request open to skip the wait.
    function requestWithdrawal(uint256 shares) external returns (uint256 id) {
        if (shares == 0) revert ZeroShares();
        _transfer(msg.sender, address(this), shares);
        id = withdrawalRequests.length;
        uint256 readyAt = block.timestamp + withdrawalWait;
        withdrawalRequests.push(WithdrawalRequest(msg.sender, uint64(readyAt), shares));
        emit WithdrawalRequested(id, msg.sender, shares, readyAt);
    }

    /// @notice Pays ready requests, oldest first, at today's share price.
    /// Anyone can call it. It stops when free capital runs out, and a part paid
    /// request keeps its place at the front of the queue.
    function processWithdrawals(uint256 maxCount) external returns (uint256 paid) {
        uint256 id = nextWithdrawal;
        while (paid < maxCount && id < withdrawalRequests.length) {
            WithdrawalRequest storage request = withdrawalRequests[id];
            if (request.readyAt > block.timestamp) break;

            uint256 shares = request.shares;
            uint256 affordable = convertToShares(freeCapital());
            if (shares > affordable) shares = affordable;
            uint256 assets = convertToAssets(shares);
            if (assets == 0) break;

            request.shares -= shares;
            bool finished = request.shares == 0;
            address backer = request.backer;
            if (finished) id++;
            paid++;

            _burn(address(this), shares);
            IERC20(asset()).safeTransfer(backer, assets);
            emit Withdraw(msg.sender, backer, backer, assets, shares);
            emit WithdrawalPaid(finished ? id - 1 : id, backer, shares, assets, finished);
            if (!finished) break;
        }
        nextWithdrawal = id;
    }

    /// @dev Shares only ever live in a backer's name or in the withdrawal queue.
    function transfer(address, uint256) public pure override(ERC20, IERC20) returns (bool) {
        revert SharesCannotBeTransferred();
    }

    function transferFrom(address, address, uint256) public pure override(ERC20, IERC20) returns (bool) {
        revert SharesCannotBeTransferred();
    }

    // Called by CoverBook

    /// @dev The premium has already reached the pool when this is called.
    function lockForCover(uint256 premium, uint256 payout) external onlyCoverBook {
        if (premium > payout) revert BadCover();
        uint256 capital = payout - premium;
        unearnedPremiums += premium;
        if (freeCapital() < capital) revert NotEnoughFreeCapital();
        lockedCapital += capital;
        emit CapitalLocked(premium, capital);
    }

    function releaseCover(address holder, uint256 premium, uint256 payout, CoverEnd end)
        external
        onlyCoverBook
        returns (uint256 paidToHolder)
    {
        uint256 capital = payout - premium;
        lockedCapital -= capital;
        unearnedPremiums -= premium;

        if (end == CoverEnd.PaidOut) paidToHolder = payout;
        else if (end == CoverEnd.Refunded) paidToHolder = premium;
        else paidToHolder = premium * memberRebateBps / 10_000;

        if (paidToHolder > 0) IERC20(asset()).safeTransfer(holder, paidToHolder);
        emit CapitalReleased(premium, capital, end, paidToHolder);
    }
}
