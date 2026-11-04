// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {CoverBook} from "../src/CoverBook.sol";
import {MutualPool} from "../src/MutualPool.sol";
import {ResultOracle} from "../src/ResultOracle.sol";

contract CoverTest is Base {
    uint128 internal constant PREMIUM = uint128(8 * ONE);
    uint128 internal constant PAYOUT = uint128(100 * ONE);
    uint40 internal time;

    function setUp() public override {
        super.setUp();
        deposit(backer, 10_000 * ONE);
        time = uint40(block.timestamp + 3 days);
    }

    function buyFlight() internal returns (uint256) {
        return buy(FLIGHT, "AB1", time, PREMIUM, PAYOUT, member);
    }

    function test_buyLocksTheFullPayout() public {
        uint256 id = buyFlight();
        assertEq(id, 1);
        assertEq(pool.lockedCapital(), PAYOUT - PREMIUM);
        assertEq(pool.unearnedPremiums(), PREMIUM);
        assertEq(pool.totalAssets(), 10_000 * ONE, "premium isn't earned yet");
        assertEq(usd.balanceOf(address(pool)), 10_000 * ONE + PREMIUM);
    }

    function test_onTimeFlightEarnsThePremium() public {
        uint256 id = buyFlight();
        vm.warp(time);
        report(keyOf(id), 30);
        vm.warp(block.timestamp + CHALLENGE);
        book.settle(id);

        assertEq(uint8(statusOf(id)), uint8(CoverBook.Status.Expired));
        assertEq(pool.totalAssets(), 10_000 * ONE + PREMIUM);
        assertEq(pool.lockedCapital(), 0);
        assertEq(pool.unearnedPremiums(), 0);
    }

    function test_lateFlightPaysTheMember() public {
        uint256 id = buyFlight();
        uint256 before = usd.balanceOf(member);
        vm.warp(time);
        report(keyOf(id), TRIGGER);
        vm.warp(block.timestamp + CHALLENGE);
        vm.prank(backer2); // anyone can trigger it
        book.settle(id);

        assertEq(uint8(statusOf(id)), uint8(CoverBook.Status.PaidOut));
        assertEq(usd.balanceOf(member), before + PAYOUT);
        assertEq(pool.totalAssets(), 10_000 * ONE - (PAYOUT - PREMIUM));
        assertEq(pool.lockedCapital(), 0);
    }

    function test_noSettleBeforeChallengeWindowEnds() public {
        uint256 id = buyFlight();
        vm.warp(time);
        report(keyOf(id), 240);
        vm.expectRevert(CoverBook.NotReady.selector);
        book.settle(id);
    }

    function test_cantSettleTwice() public {
        uint256 id = buyFlight();
        vm.warp(time);
        report(keyOf(id), 240);
        vm.warp(block.timestamp + CHALLENGE);
        book.settle(id);
        vm.expectRevert(CoverBook.NotReady.selector);
        book.settle(id);
    }

    function test_settleManySkipsWhatIsntReady() public {
        uint256 ready = buyFlight();
        uint256 waiting = buy(FLIGHT, "AB2", time, PREMIUM, PAYOUT, member);
        vm.warp(time);
        report(keyOf(ready), 240);
        vm.warp(block.timestamp + CHALLENGE);
        uint256[] memory ids = new uint256[](2);
        ids[0] = ready;
        ids[1] = waiting;
        assertEq(book.settleMany(ids), 1);
        assertEq(uint8(statusOf(waiting)), uint8(CoverBook.Status.Active));
    }

    function test_refundAfterDeadlineIfNoResult() public {
        uint256 id = buyFlight();
        vm.expectRevert(CoverBook.NotReady.selector);
        book.refund(id);

        vm.warp(time + DEADLINE + 1);
        uint256 before = usd.balanceOf(member);
        book.refund(id);
        assertEq(uint8(statusOf(id)), uint8(CoverBook.Status.Refunded));
        assertEq(usd.balanceOf(member), before + PREMIUM);
        assertEq(pool.totalAssets(), 10_000 * ONE);
        assertEq(pool.lockedCapital(), 0);
    }

    function test_noRefundOnceAResultIsDecided() public {
        uint256 id = buyFlight();
        vm.warp(time + DEADLINE);
        report(keyOf(id), 240);
        vm.warp(block.timestamp + 2);
        vm.expectRevert(CoverBook.NotReady.selector);
        book.refund(id);
    }

    function test_salesCloseBeforeTheCutoff() public {
        vm.warp(time - CUTOFF + 1);
        (CoverBook.Quote memory q, bytes memory s) = quote(FLIGHT, "AB1", time, PREMIUM, PAYOUT, member);
        vm.prank(member);
        vm.expectRevert(CoverBook.SalesClosed.selector);
        book.buy(q, s);
    }

    function test_quoteMustBeSignedByTheQuoter() public {
        (CoverBook.Quote memory q,) = quote(FLIGHT, "AB1", time, PREMIUM, PAYOUT, member);
        bytes memory forged = sign(q, 0xBAD);
        vm.prank(member);
        vm.expectRevert(CoverBook.BadSignature.selector);
        book.buy(q, forged);
    }

    function test_quoteCantBeChanged() public {
        (CoverBook.Quote memory q, bytes memory s) = quote(FLIGHT, "AB1", time, PREMIUM, PAYOUT, member);
        q.premium = 1;
        vm.prank(member);
        vm.expectRevert(CoverBook.BadSignature.selector);
        book.buy(q, s);
    }

    function test_quoteWorksOnce() public {
        (CoverBook.Quote memory q, bytes memory s) = quote(FLIGHT, "AB1", time, PREMIUM, PAYOUT, member);
        vm.prank(member);
        book.buy(q, s);
        vm.prank(member);
        vm.expectRevert(CoverBook.QuoteAlreadyUsed.selector);
        book.buy(q, s);
    }

    function test_quoteExpires() public {
        (CoverBook.Quote memory q, bytes memory s) = quote(FLIGHT, "AB1", time, PREMIUM, PAYOUT, member);
        vm.warp(block.timestamp + 11 minutes);
        vm.prank(member);
        vm.expectRevert(CoverBook.QuoteExpired.selector);
        book.buy(q, s);
    }

    function test_quoteIsForOneBuyer() public {
        (CoverBook.Quote memory q, bytes memory s) = quote(FLIGHT, "AB1", time, PREMIUM, PAYOUT, member);
        vm.prank(backer);
        vm.expectRevert(CoverBook.NotTheBuyer.selector);
        book.buy(q, s);
    }

    function test_badAmountsAreRefused() public {
        (CoverBook.Quote memory q, bytes memory s) = quote(FLIGHT, "AB1", time, PAYOUT, PAYOUT, member);
        vm.prank(member);
        vm.expectRevert(CoverBook.BadAmounts.selector);
        book.buy(q, s);
    }

    function test_eventLimitCapsOneFlight() public {
        // Limit is 10% of 10,000, so 1,000 of cover on one flight.
        for (uint256 i; i < 10; i++) buyFlight();
        (CoverBook.Quote memory q, bytes memory s) = quote(FLIGHT, "AB1", time, PREMIUM, PAYOUT, member);
        vm.prank(member);
        vm.expectRevert(CoverBook.OverEventLimit.selector);
        book.buy(q, s);
    }

    function test_salesStopWhenThePoolIsFullyLocked() public {
        // Each cover needs 92 of capital, so 10,000 backs 108 of them.
        uint256 sold;
        for (uint256 i; i < 120; i++) {
            bytes32 ref = keccak256(abi.encode(i));
            (CoverBook.Quote memory q, bytes memory s) = quote(FLIGHT, ref, time, PREMIUM, PAYOUT, member);
            vm.prank(member);
            try book.buy(q, s) {
                sold++;
            } catch (bytes memory reason) {
                assertEq(bytes4(reason), MutualPool.NotEnoughFreeCapital.selector);
                break;
            }
        }
        assertEq(sold, 108, "10,000 / 92 capital per cover");
        assertGe(usd.balanceOf(address(pool)), sold * PAYOUT);
    }

    function test_pauseStopsSalesButNotSettling() public {
        uint256 id = buyFlight();
        vm.prank(guardian);
        pool.setPaused(true);

        (CoverBook.Quote memory q, bytes memory s) = quote(FLIGHT, "AB2", time, PREMIUM, PAYOUT, member);
        vm.prank(member);
        vm.expectRevert(CoverBook.Paused.selector);
        book.buy(q, s);

        vm.warp(time);
        report(keyOf(id), 240);
        vm.warp(block.timestamp + CHALLENGE);
        book.settle(id);
        assertEq(uint8(statusOf(id)), uint8(CoverBook.Status.PaidOut));
    }

    function test_memberRebateOnExpiry() public {
        vm.prank(admin);
        pool.setMemberRebateBps(1_000);
        uint256 id = buyFlight();
        uint256 before = usd.balanceOf(member);
        vm.warp(time);
        report(keyOf(id), 0);
        vm.warp(block.timestamp + CHALLENGE);
        book.settle(id);
        assertEq(usd.balanceOf(member) - before, PREMIUM / 10);
        assertEq(pool.totalAssets(), 10_000 * ONE + PREMIUM - PREMIUM / 10);
    }

    function test_disabledProductCantBeSold() public {
        vm.prank(admin);
        book.setProduct(FLIGHT, CoverBook.Product(false, CoverBook.Kind.Automatic, TRIGGER, CUTOFF, DEADLINE, 1_000, uint128(1_000 * ONE)));
        (CoverBook.Quote memory q, bytes memory s) = quote(FLIGHT, "AB1", time, PREMIUM, PAYOUT, member);
        vm.prank(member);
        vm.expectRevert(CoverBook.ProductNotActive.selector);
        book.buy(q, s);
    }

    function testFuzz_settlementKeepsTheBooksBalanced(uint32 premiumSeed, uint32 payoutSeed, uint32 delay) public {
        uint128 payout = uint128(bound(uint256(payoutSeed), 2 * ONE, 900 * ONE));
        uint128 premium = uint128(bound(uint256(premiumSeed), 1, payout - 1));
        uint256 id = buy(FLIGHT, "AB9", time, premium, payout, member);
        vm.warp(time);
        report(keyOf(id), delay);
        vm.warp(block.timestamp + CHALLENGE);
        book.settle(id);

        assertEq(pool.lockedCapital(), 0);
        assertEq(pool.unearnedPremiums(), 0);
        uint256 expected = delay >= TRIGGER ? 10_000 * ONE - (payout - premium) : 10_000 * ONE + premium;
        assertEq(pool.totalAssets(), expected);
    }
}

contract OracleTest is Base {
    bytes32 internal key;
    uint40 internal time;

    function setUp() public override {
        super.setUp();
        deposit(backer, 10_000 * ONE);
        time = uint40(block.timestamp + 3 days);
        key = keyOf(buy(FLIGHT, "AB1", time, uint128(8 * ONE), uint128(100 * ONE), member));
    }

    function test_oneReporterCantDecide() public {
        vm.warp(time);
        vm.prank(reporter1);
        oracle.report(key, 500);
        assertEq(uint8(oracle.state(key)), uint8(ResultOracle.State.Waiting));
    }

    function test_oneLiarIsOutvoted() public {
        vm.warp(time);
        vm.prank(reporter1);
        oracle.report(key, 999);
        vm.prank(reporter2);
        oracle.report(key, 20);
        vm.prank(reporter3);
        oracle.report(key, 15);
        assertEq(uint8(oracle.state(key)), uint8(ResultOracle.State.InChallengeWindow));
        assertFalse(oracle.triggered(key));
    }

    function test_reporterVotesOnce() public {
        vm.warp(time);
        vm.startPrank(reporter1);
        oracle.report(key, 500);
        vm.expectRevert(ResultOracle.AlreadyReported.selector);
        oracle.report(key, 500);
        vm.stopPrank();
    }

    function test_onlyReportersReport() public {
        vm.warp(time);
        vm.expectRevert(ResultOracle.NotReporter.selector);
        oracle.report(key, 500);
    }

    function test_onTimeCantBeReportedEarly() public {
        vm.warp(time - 1);
        vm.prank(reporter1);
        vm.expectRevert(ResultOracle.TooEarly.selector);
        oracle.report(key, 10);
    }

    function test_cancellationCanBeReportedAfterSalesClose() public {
        vm.warp(time - CUTOFF);
        vm.prank(reporter1);
        oracle.report(key, type(uint32).max);
    }

    function test_lateCantBeReportedWhileSalesAreOpen() public {
        vm.warp(time - CUTOFF - 1);
        vm.prank(reporter1);
        vm.expectRevert(ResultOracle.TooEarly.selector);
        oracle.report(key, type(uint32).max);
    }

    function test_guardianCanRejectInTheWindow() public {
        vm.warp(time);
        report(key, 500);
        vm.prank(guardian);
        oracle.reject(key);
        assertEq(uint8(oracle.state(key)), uint8(ResultOracle.State.Waiting));

        // Everyone can vote again in the new round.
        report(key, 20);
        vm.warp(block.timestamp + CHALLENGE);
        assertEq(uint8(oracle.state(key)), uint8(ResultOracle.State.Final));
        assertFalse(oracle.triggered(key));
    }

    function test_guardianCantRejectLater() public {
        vm.warp(time);
        report(key, 500);
        vm.warp(block.timestamp + CHALLENGE);
        vm.prank(guardian);
        vm.expectRevert(ResultOracle.NotInChallengeWindow.selector);
        oracle.reject(key);
    }

    function test_onlyGuardianRejects() public {
        vm.warp(time);
        report(key, 500);
        vm.expectRevert(ResultOracle.NotGuardian.selector);
        oracle.reject(key);
    }

    function test_onlyTheBookRegisters() public {
        vm.expectRevert(ResultOracle.NotRegistrar.selector);
        oracle.register("x", 1, 1, 1);
    }
}
