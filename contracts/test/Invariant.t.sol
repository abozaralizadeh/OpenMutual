// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {MutualPool} from "../src/MutualPool.sol";
import {ResultOracle} from "../src/ResultOracle.sol";
import {CoverBook} from "../src/CoverBook.sol";

/// @dev Does random things to the system and remembers what it promised.
contract Handler is Test {
    uint32 internal constant WIDE_OPEN_PRODUCT = 3;

    TestUSD internal usd;
    MutualPool internal pool;
    ResultOracle internal oracle;
    CoverBook internal book;
    uint256 internal quoterKey;
    address[3] internal reporters;
    address[3] internal backers = [address(0xB1), address(0xB2), address(0xB3)];
    address internal member = address(0xCA);
    uint256 internal nonce;

    uint256[] public open;

    constructor(TestUSD usd_, MutualPool pool_, ResultOracle oracle_, CoverBook book_, uint256 quoterKey_, address[3] memory reporters_) {
        usd = usd_;
        pool = pool_;
        oracle = oracle_;
        book = book_;
        quoterKey = quoterKey_;
        reporters = reporters_;
        for (uint256 i; i < 3; i++) {
            usd.faucet(backers[i]);
            vm.prank(backers[i]);
            usd.approve(address(pool), type(uint256).max);
        }
        for (uint256 i; i < 50; i++) usd.faucet(member);
        vm.prank(member);
        usd.approve(address(book), type(uint256).max);
    }

    function deposit(uint256 who, uint256 amount) external {
        address backer = backers[who % 3];
        amount = bound(amount, 1e6, 3_000e6);
        if (usd.balanceOf(backer) < amount) usd.faucet(backer);
        vm.prank(backer);
        pool.deposit(amount, backer);
    }

    function askToWithdraw(uint256 who, uint256 shares) external {
        address backer = backers[who % 3];
        uint256 balance = pool.balanceOf(backer);
        if (balance == 0) return;
        vm.prank(backer);
        pool.requestWithdrawal(bound(shares, 1, balance));
    }

    function processQueue(uint256 count) external {
        pool.processWithdrawals(bound(count, 1, 5));
    }

    function buy(uint256 flight, uint256 premiumSeed, uint256 payoutSeed) external {
        // Sized around free capital, so buys often land right at the edge of the pool.
        uint256 most = pool.freeCapital() * 3 / 2 + 100e6;
        uint128 payout = uint128(bound(payoutSeed, 10e6, most));
        uint128 premium = uint128(bound(premiumSeed, 1e6, payout / 5));
        CoverBook.Quote memory q = CoverBook.Quote(
            WIDE_OPEN_PRODUCT,
            bytes32(flight % 12),
            uint40((block.timestamp / 1 days + 3) * 1 days),
            premium,
            payout,
            member,
            uint40(block.timestamp + 10 minutes),
            keccak256(abi.encode(++nonce))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(quoterKey, book.quoteDigest(q));
        vm.prank(member);
        open.push(book.buy(q, abi.encodePacked(r, s, v)));
    }

    function reportResult(uint256 index, uint32 value, uint256 reporter) external {
        if (open.length == 0) return;
        (,,,,,, bytes32 key) = book.covers(open[index % open.length]);
        vm.prank(reporters[reporter % 3]);
        oracle.report(key, value);
    }

    function settle(uint256 index) external {
        if (open.length == 0) return;
        book.settle(open[index % open.length]);
    }

    function refund(uint256 index) external {
        if (open.length == 0) return;
        book.refund(open[index % open.length]);
    }

    function passTime(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1 minutes, 3 days));
    }

    function coverCount() external view returns (uint256) {
        return open.length;
    }
}

contract InvariantTest is Base {
    Handler internal handler;

    function setUp() public override {
        super.setUp();
        // No per-event limit here, so random buying really does reach the edge of the pool.
        vm.prank(admin);
        book.addProduct(CoverBook.Product(true, CoverBook.Kind.Automatic, TRIGGER, CUTOFF, DEADLINE, 10_000, type(uint128).max));
        handler = new Handler(usd, pool, oracle, book, quoterKey, [reporter1, reporter2, reporter3]);
        targetContract(address(handler));
    }

    /// @dev What the pool owes right now, added up cover by cover.
    function owed() internal view returns (uint256 total, uint256 premiums) {
        for (uint256 id = 1; id <= book.coverCount(); id++) {
            (,,, CoverBook.Status status, uint128 premium, uint128 payout,) = book.covers(id);
            if (status == CoverBook.Status.Active || status == CoverBook.Status.ClaimOpen) {
                total += payout;
                premiums += premium;
            }
        }
    }

    function invariant_poolCanAlwaysPayEveryActiveCover() public view {
        (uint256 total,) = owed();
        assertGe(usd.balanceOf(address(pool)), total);
    }

    function invariant_booksMatchTheCovers() public view {
        (uint256 total, uint256 premiums) = owed();
        assertEq(pool.unearnedPremiums(), premiums);
        assertEq(pool.lockedCapital(), total - premiums);
    }

    function invariant_capitalCoversTheLockedPart() public view {
        assertGe(pool.totalAssets(), pool.lockedCapital());
    }
}
