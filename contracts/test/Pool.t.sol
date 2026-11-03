// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Base} from "./Base.t.sol";
import {MutualPool} from "../src/MutualPool.sol";

contract PoolTest is Base {
    function test_depositGivesShares() public {
        uint256 shares = deposit(backer, 1_000 * ONE);
        assertEq(pool.balanceOf(backer), shares);
        assertEq(pool.totalAssets(), 1_000 * ONE);
        assertEq(pool.freeCapital(), 1_000 * ONE);
    }

    function test_depositStopsAtCap() public {
        vm.prank(admin);
        pool.setPoolCap(500 * ONE);
        vm.prank(backer);
        vm.expectRevert();
        pool.deposit(501 * ONE, backer);
        deposit(backer, 500 * ONE);
        assertEq(pool.maxDeposit(backer), 0);
    }

    function test_pauseStopsDeposits() public {
        vm.prank(guardian);
        pool.setPaused(true);
        vm.prank(backer);
        vm.expectRevert();
        pool.deposit(ONE, backer);
    }

    function test_onlyGuardianPauses() public {
        vm.expectRevert(MutualPool.NotGuardian.selector);
        pool.setPaused(true);
    }

    function test_plainExitsAreClosed() public {
        deposit(backer, 1_000 * ONE);
        vm.startPrank(backer);
        vm.expectRevert();
        pool.withdraw(ONE, backer, backer);
        vm.expectRevert();
        pool.redeem(ONE, backer, backer);
        vm.stopPrank();
    }

    function test_sharesCantBeTransferred() public {
        uint256 shares = deposit(backer, 1_000 * ONE);
        vm.startPrank(backer);
        vm.expectRevert(MutualPool.SharesCannotBeTransferred.selector);
        pool.transfer(backer2, shares);
        pool.approve(backer2, shares);
        vm.stopPrank();
        vm.prank(backer2);
        vm.expectRevert(MutualPool.SharesCannotBeTransferred.selector);
        pool.transferFrom(backer, backer2, shares);
    }

    function test_withdrawalWaitsThenPays() public {
        uint256 shares = deposit(backer, 1_000 * ONE);
        uint256 before = usd.balanceOf(backer);
        vm.prank(backer);
        pool.requestWithdrawal(shares);

        pool.processWithdrawals(10);
        assertEq(usd.balanceOf(backer), before, "paid too early");

        vm.warp(block.timestamp + WAIT);
        pool.processWithdrawals(10);
        assertApproxEqAbs(usd.balanceOf(backer), before + 1_000 * ONE, 2);
        assertEq(pool.pendingWithdrawals(), 0);
    }

    function test_withdrawalIsPricedAtTheEndOfTheWait() public {
        uint256 shares = deposit(backer, 1_000 * ONE);
        vm.prank(backer);
        pool.requestWithdrawal(shares);

        // A cover sold and lost during the wait hits the leaving backer too.
        uint40 time = uint40(block.timestamp + 2 days);
        uint256 id = buy(FLIGHT, "AB1", time, uint128(8 * ONE), uint128(100 * ONE), member);
        vm.warp(time);
        report(keyOf(id), 240);
        vm.warp(block.timestamp + CHALLENGE);
        book.settle(id);

        vm.warp(block.timestamp + WAIT);
        uint256 before = usd.balanceOf(backer);
        pool.processWithdrawals(10);
        assertApproxEqAbs(usd.balanceOf(backer) - before, 908 * ONE, 2);
    }

    function test_withdrawalOnlyTakesFreeCapital() public {
        uint256 shares = deposit(backer, 1_000 * ONE);
        uint40 time = uint40(block.timestamp + 30 days);
        uint256 id = buy(FLIGHT, "AB1", time, uint128(8 * ONE), uint128(100 * ONE), member);

        vm.prank(backer);
        pool.requestWithdrawal(shares);
        vm.warp(block.timestamp + WAIT);
        uint256 before = usd.balanceOf(backer);
        pool.processWithdrawals(10);

        assertApproxEqAbs(usd.balanceOf(backer) - before, 908 * ONE, 2);
        assertEq(pool.pendingWithdrawals(), 1, "rest stays in the queue");
        assertGe(usd.balanceOf(address(pool)), 100 * ONE, "cover must stay fully backed");

        // The rest is paid once the reserve is freed.
        vm.warp(time);
        report(keyOf(id), 10);
        vm.warp(block.timestamp + CHALLENGE);
        book.settle(id);
        pool.processWithdrawals(10);
        assertEq(pool.pendingWithdrawals(), 0);
    }

    function test_queueIsOldestFirst() public {
        uint256 a = deposit(backer, 500 * ONE);
        uint256 b = deposit(backer2, 500 * ONE);
        vm.prank(backer);
        pool.requestWithdrawal(a);
        vm.warp(block.timestamp + 1 days);
        vm.prank(backer2);
        pool.requestWithdrawal(b);

        vm.warp(block.timestamp + WAIT - 1 days);
        uint256 before = usd.balanceOf(backer2);
        pool.processWithdrawals(10);
        assertEq(pool.pendingWithdrawals(), 1);
        assertEq(usd.balanceOf(backer2), before, "not ready yet");
    }

    function test_withdrawalsStayOpenWhilePaused() public {
        uint256 shares = deposit(backer, 1_000 * ONE);
        vm.prank(backer);
        pool.requestWithdrawal(shares);
        vm.prank(guardian);
        pool.setPaused(true);
        vm.warp(block.timestamp + WAIT);
        pool.processWithdrawals(10);
        assertEq(pool.pendingWithdrawals(), 0);
    }

    function test_cantRequestZero() public {
        vm.expectRevert(MutualPool.ZeroShares.selector);
        pool.requestWithdrawal(0);
    }

    function test_settingLimits() public {
        vm.startPrank(admin);
        vm.expectRevert(MutualPool.ValueTooHigh.selector);
        pool.setWithdrawalWait(31 days);
        vm.expectRevert(MutualPool.ValueTooHigh.selector);
        pool.setMemberRebateBps(5_001);
        vm.expectRevert(MutualPool.CoverBookAlreadySet.selector);
        pool.setCoverBook(address(1));
        vm.stopPrank();
    }

    function test_onlyCoverBookMovesReserves() public {
        vm.expectRevert(MutualPool.NotCoverBook.selector);
        pool.lockForCover(1, 2);
        vm.expectRevert(MutualPool.NotCoverBook.selector);
        pool.releaseCover(member, 1, 2, MutualPool.CoverEnd.PaidOut);
    }

    function testFuzz_depositThenFullExitNeverGainsFromNothing(uint96 amount) public {
        uint256 value = bound(uint256(amount), ONE, 100_000 * ONE);
        uint256 before = usd.balanceOf(backer);
        uint256 shares = deposit(backer, value);
        vm.prank(backer);
        pool.requestWithdrawal(shares);
        vm.warp(block.timestamp + WAIT);
        pool.processWithdrawals(1);
        assertLe(usd.balanceOf(backer), before);
    }
}
