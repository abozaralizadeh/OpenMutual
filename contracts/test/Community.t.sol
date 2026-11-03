// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Base} from "./Base.t.sol";
import {CoverBook} from "../src/CoverBook.sol";
import {ClaimReview} from "../src/ClaimReview.sol";
import {MemberGovernor} from "../src/MemberGovernor.sol";
import {Membership} from "../src/Membership.sol";
import {MutualPool} from "../src/MutualPool.sol";
import {TeamMultisig} from "../src/TeamMultisig.sol";

contract ClaimReviewTest is Base {
    address internal m1 = makeAddr("m1");
    address internal m2 = makeAddr("m2");
    address internal m3 = makeAddr("m3");
    address internal m4 = makeAddr("m4");
    uint128 internal constant PREMIUM = uint128(10 * ONE);
    uint128 internal constant PAYOUT = uint128(200 * ONE);
    uint40 internal end;
    uint256 internal coverId;

    function setUp() public override {
        super.setUp();
        deposit(backer, 10_000 * ONE);
        vm.startPrank(verifier);
        members.add(m1);
        members.add(m2);
        members.add(m3);
        members.add(m4);
        members.add(member);
        vm.stopPrank();
        vm.warp(block.timestamp + 1);
        end = uint40(block.timestamp + 5 days);
        coverId = buy(BAG, "trip-1", end, PREMIUM, PAYOUT, member);
    }

    function file() internal returns (uint256) {
        vm.prank(member);
        return book.fileClaim(coverId, "evidence");
    }

    function voteAs(uint256 id, address who, bool approve) internal {
        vm.prank(who);
        review.vote(id, approve);
    }

    function test_approvedClaimPays() public {
        uint256 id = file();
        vm.warp(block.timestamp + 1);
        voteAs(id, m1, true);
        voteAs(id, m2, true);
        voteAs(id, m3, false);
        vm.warp(block.timestamp + 3 days);
        uint256 before = usd.balanceOf(member);
        review.finish(id);
        assertEq(usd.balanceOf(member), before + PAYOUT);
        assertEq(uint8(statusOf(coverId)), uint8(CoverBook.Status.PaidOut));
    }

    function test_rejectedClaimEndsTheCover() public {
        uint256 id = file();
        vm.warp(block.timestamp + 1);
        voteAs(id, m1, false);
        voteAs(id, m2, false);
        voteAs(id, m3, true);
        vm.warp(block.timestamp + 3 days);
        review.finish(id);
        assertEq(uint8(statusOf(coverId)), uint8(CoverBook.Status.Expired));
    }

    function test_tooFewVotesRefundsThePremium() public {
        uint256 id = file();
        vm.warp(block.timestamp + 1);
        voteAs(id, m1, true);
        vm.warp(block.timestamp + 3 days);
        uint256 before = usd.balanceOf(member);
        review.finish(id);
        assertEq(usd.balanceOf(member), before + PREMIUM);
        assertEq(uint8(statusOf(coverId)), uint8(CoverBook.Status.Refunded));
    }

    function test_cantVoteOnYourOwnClaim() public {
        uint256 id = file();
        vm.warp(block.timestamp + 1);
        vm.prank(member);
        vm.expectRevert(ClaimReview.OwnClaim.selector);
        review.vote(id, true);
    }

    function test_oneVoteEach() public {
        uint256 id = file();
        vm.warp(block.timestamp + 1);
        voteAs(id, m1, true);
        vm.prank(m1);
        vm.expectRevert(ClaimReview.AlreadyVoted.selector);
        review.vote(id, true);
    }

    function test_nonMembersCantVote() public {
        uint256 id = file();
        vm.warp(block.timestamp + 1);
        vm.prank(backer);
        vm.expectRevert(ClaimReview.NotEligible.selector);
        review.vote(id, true);
    }

    function test_joiningAfterTheClaimOpensDoesntCount() public {
        uint256 id = file();
        vm.warp(block.timestamp + 1);
        address late = makeAddr("late");
        vm.prank(verifier);
        members.add(late);
        vm.prank(late);
        vm.expectRevert(ClaimReview.NotEligible.selector);
        review.vote(id, true);
    }

    function test_cantFinishEarly() public {
        uint256 id = file();
        vm.expectRevert(ClaimReview.VotingOpen.selector);
        review.finish(id);
    }

    function test_cantFinishTwice() public {
        uint256 id = file();
        vm.warp(block.timestamp + 3 days);
        review.finish(id);
        vm.expectRevert(ClaimReview.Finished.selector);
        review.finish(id);
    }

    function test_onlyHolderCanClaim() public {
        vm.prank(m1);
        vm.expectRevert(CoverBook.NotHolder.selector);
        book.fileClaim(coverId, "x");
    }

    function test_claimWindowCloses() public {
        vm.warp(end + DEADLINE + 1);
        vm.prank(member);
        vm.expectRevert(CoverBook.ClaimWindowClosed.selector);
        book.fileClaim(coverId, "x");
    }

    function test_noClaimExpiresAfterTheWindow() public {
        assertFalse(book.canSettle(coverId));
        vm.warp(end + DEADLINE + 1);
        book.settle(coverId);
        assertEq(uint8(statusOf(coverId)), uint8(CoverBook.Status.Expired));
    }

    function test_openClaimCantBeSettledAround() public {
        file();
        vm.warp(end + DEADLINE + 1);
        assertFalse(book.canSettle(coverId));
        assertFalse(book.canRefund(coverId));
    }

    function test_onlyReviewResolves() public {
        file();
        vm.expectRevert(CoverBook.NotClaimReview.selector);
        book.resolveClaim(coverId, CoverBook.ClaimOutcome.Approved);
    }
}

contract GovernanceTest is Base {
    TimelockController internal timelock;
    MemberGovernor internal governor;
    TeamMultisig internal multisig;
    address internal m1 = makeAddr("m1");
    address internal m2 = makeAddr("m2");
    address internal m3 = makeAddr("m3");
    address internal s1 = makeAddr("s1");
    address internal s2 = makeAddr("s2");
    address internal s3 = makeAddr("s3");
    uint256 internal constant DELAY = 1 days;

    function setUp() public override {
        super.setUp();
        address[] memory none = new address[](0);
        address[] memory open = new address[](1);
        timelock = new TimelockController(DELAY, none, open, address(this));

        address[] memory targets = new address[](1);
        bytes4[] memory selectors = new bytes4[](1);
        targets[0] = address(pool);
        selectors[0] = MutualPool.setMemberRebateBps.selector;
        governor = new MemberGovernor(members, timelock, 2 days, 1_000, 2, targets, selectors);

        address[] memory signers = new address[](3);
        signers[0] = s1;
        signers[1] = s2;
        signers[2] = s3;
        multisig = new TeamMultisig(signers, 2);

        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(multisig));
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), address(this));

        vm.prank(admin);
        pool.transferOwnership(address(timelock));

        vm.startPrank(verifier);
        members.add(m1);
        members.add(m2);
        members.add(m3);
        vm.stopPrank();
        vm.warp(block.timestamp + 1);
    }

    function rebateCall(uint256 bps) internal pure returns (bytes memory) {
        return abi.encodeCall(MutualPool.setMemberRebateBps, (bps));
    }

    function propose() internal returns (uint256 id) {
        vm.prank(m1);
        id = governor.propose(address(pool), rebateCall(500), "share 5%");
        vm.warp(block.timestamp + 1);
    }

    function test_passedVoteChangesTheSettingAfterTheDelay() public {
        uint256 id = propose();
        vm.prank(m1);
        governor.vote(id, true);
        vm.prank(m2);
        governor.vote(id, true);
        vm.prank(m3);
        governor.vote(id, false);

        vm.warp(block.timestamp + 2 days);
        governor.queue(id);

        vm.expectRevert();
        governor.execute(id);

        vm.warp(block.timestamp + DELAY);
        governor.execute(id);
        assertEq(pool.memberRebateBps(), 500);
    }

    function test_oneMemberOneVote() public {
        uint256 id = propose();
        vm.startPrank(m1);
        governor.vote(id, true);
        vm.expectRevert(MemberGovernor.AlreadyVoted.selector);
        governor.vote(id, true);
        vm.stopPrank();
    }

    function test_moneyBuysNoVotes() public {
        deposit(backer, 100_000 * ONE);
        uint256 id = propose();
        vm.prank(backer);
        vm.expectRevert(MemberGovernor.NotEligible.selector);
        governor.vote(id, true);
    }

    function test_failedVoteCantBeQueued() public {
        uint256 id = propose();
        vm.prank(m1);
        governor.vote(id, false);
        vm.prank(m2);
        governor.vote(id, false);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(MemberGovernor.DidNotPass.selector);
        governor.queue(id);
    }

    function test_tooFewVotesCantPass() public {
        uint256 id = propose();
        vm.prank(m1);
        governor.vote(id, true);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(MemberGovernor.DidNotPass.selector);
        governor.queue(id);
    }

    function test_membersCantProposeAnything() public {
        vm.prank(m1);
        vm.expectRevert(MemberGovernor.NotAllowed.selector);
        governor.propose(address(pool), abi.encodeCall(MutualPool.setGuardian, (m1)), "take over");
    }

    function test_nonMembersCantPropose() public {
        vm.expectRevert(MemberGovernor.NotMember.selector);
        governor.propose(address(pool), rebateCall(1), "x");
    }

    function test_settingsCantBeChangedDirectly() public {
        vm.prank(admin);
        vm.expectRevert();
        pool.setMemberRebateBps(1);
    }

    function test_oneSignerIsNotEnough() public {
        bytes memory schedule = abi.encodeCall(timelock.schedule, (address(pool), 0, rebateCall(100), bytes32(0), bytes32(0), DELAY));
        vm.prank(s1);
        uint256 id = multisig.submit(address(timelock), schedule);
        vm.prank(s1);
        vm.expectRevert(TeamMultisig.NotEnoughConfirmations.selector);
        multisig.execute(id);
    }

    function test_teamChangeNeedsTwoSignersAndTheDelay() public {
        bytes memory schedule = abi.encodeCall(timelock.schedule, (address(pool), 0, rebateCall(100), bytes32(0), bytes32(0), DELAY));
        vm.prank(s1);
        uint256 id = multisig.submit(address(timelock), schedule);
        vm.prank(s2);
        multisig.confirm(id);
        vm.prank(s2);
        multisig.execute(id);

        vm.expectRevert();
        timelock.execute(address(pool), 0, rebateCall(100), bytes32(0), bytes32(0));

        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(pool), 0, rebateCall(100), bytes32(0), bytes32(0));
        assertEq(pool.memberRebateBps(), 100);
    }

    function test_strangersCantSign() public {
        vm.expectRevert(TeamMultisig.NotSigner.selector);
        multisig.submit(address(pool), "");
    }

    function test_removedMemberCantVote() public {
        uint256 id = propose();
        vm.prank(verifier);
        members.remove(m2);
        vm.prank(m2);
        vm.expectRevert(MemberGovernor.NotEligible.selector);
        governor.vote(id, true);
    }
}
