// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {ClaimLadder} from "../src/ClaimLadder.sol";
import {CoverBook} from "../src/CoverBook.sol";

contract ClaimLadderTest is Base {
    ClaimLadder internal ladder;
    address internal auditor = makeAddr("auditor");
    address internal outsider = makeAddr("outsider");
    address[] internal assessorsList;
    address[] internal jurorsList;

    uint128 internal constant PREMIUM = uint128(10 * ONE);
    uint128 internal constant PAYOUT = uint128(200 * ONE);
    uint256 internal constant ASSESSOR_BOND = 1_000 * ONE;
    uint256 internal constant JUROR_BOND = 100 * ONE;
    uint256 internal constant CHALLENGE_BOND = 20 * ONE;
    uint256 internal constant APPEAL_BOND = 20 * ONE;
    bytes32 internal constant REASON = keccak256("reason");

    uint256 internal coverId;
    uint256 private trips;

    function setUp() public override {
        super.setUp();
        ladder = new ClaimLadder(
            book,
            members,
            auditor,
            ClaimLadder.Settings({
                panelSize: 5,
                minMakers: 3,
                minConfidence: 80,
                jurySize: 5,
                juryQuorum: 3,
                appealJurySize: 7,
                appealQuorum: 4,
                commitTime: 12 hours,
                revealTime: 12 hours,
                challengeTime: 2 days,
                appealTime: 2 days,
                testWindow: 1 hours,
                assessorBond: uint128(ASSESSOR_BOND),
                jurorBond: uint128(JUROR_BOND),
                challengeBond: uint128(CHALLENGE_BOND),
                appealBond: uint128(APPEAL_BOND)
            })
        );
        vm.prank(admin);
        book.setClaimReview(address(ladder));
        deposit(backer, 100_000 * ONE);

        bytes32[6] memory makers = [bytes32("kestrel"), "kestrel", "sable", "ash", "moss", "northwind"];
        for (uint256 i; i < makers.length; i++) assessorsList.push(addAssessor(string.concat("assessor", vm.toString(i)), makers[i]));
        for (uint256 i; i < 14; i++) jurorsList.push(addJuror(string.concat("juror", vm.toString(i))));

        usd.faucet(outsider);
        vm.prank(outsider);
        usd.approve(address(ladder), type(uint256).max);
        vm.prank(member);
        usd.approve(address(ladder), type(uint256).max);
        vm.prank(verifier);
        members.add(member);
        vm.warp(block.timestamp + 1);
        coverId = newCover();
    }

    function addAssessor(string memory name, bytes32 maker) internal returns (address who) {
        who = makeAddr(name);
        usd.faucet(who);
        vm.startPrank(who);
        usd.approve(address(ladder), type(uint256).max);
        ladder.joinAssessors(maker);
        vm.stopPrank();
    }

    function addJuror(string memory name) internal returns (address who) {
        who = makeAddr(name);
        usd.faucet(who);
        vm.prank(verifier);
        members.add(who);
        vm.startPrank(who);
        usd.approve(address(ladder), type(uint256).max);
        ladder.joinJury();
        vm.stopPrank();
    }

    function newCover() internal returns (uint256) {
        return buy(BAG, keccak256(abi.encode("trip", ++trips)), uint40(block.timestamp + 5 days), PREMIUM, PAYOUT, member);
    }

    function file(uint256 id) internal returns (uint256) {
        vm.prank(member);
        return book.fileClaim(id, "evidence");
    }

    function seats(uint256 claimId, uint8 round) internal view returns (address[] memory) {
        return ladder.getRound(claimId, round).seats;
    }

    function saltOf(address who, uint256 claimId, uint8 round) internal pure returns (bytes32) {
        return keccak256(abi.encode(who, claimId, round));
    }

    function commitAs(uint256 claimId, uint8 round, address who, ClaimLadder.Verdict verdict, uint8 confidence) internal {
        bytes32 hash = ladder.voteHash(claimId, round, who, verdict, confidence, REASON, saltOf(who, claimId, round));
        vm.prank(who);
        ladder.commit(claimId, hash);
    }

    function revealAs(uint256 claimId, uint8 round, address who, ClaimLadder.Verdict verdict, uint8 confidence) internal {
        vm.prank(who);
        ladder.reveal(claimId, verdict, confidence, REASON, saltOf(who, claimId, round));
    }

    /// Everyone on the round answers in the order given. A verdict of None means that seat stays silent.
    function answer(uint256 claimId, uint8 round, ClaimLadder.Verdict[] memory verdicts, uint8 confidence) internal {
        address[] memory list = seats(claimId, round);
        for (uint256 i; i < list.length; i++) {
            if (verdicts[i] != ClaimLadder.Verdict.None) commitAs(claimId, round, list[i], verdicts[i], confidence);
        }
        vm.warp(block.timestamp + 12 hours);
        for (uint256 i; i < list.length; i++) {
            if (verdicts[i] != ClaimLadder.Verdict.None) revealAs(claimId, round, list[i], verdicts[i], confidence);
        }
    }

    function all(uint256 n, ClaimLadder.Verdict verdict) internal pure returns (ClaimLadder.Verdict[] memory list) {
        list = new ClaimLadder.Verdict[](n);
        for (uint256 i; i < n; i++) list[i] = verdict;
    }

    function mix(uint256 pay, uint256 deny, uint256 unclear, uint256 silent) internal pure returns (ClaimLadder.Verdict[] memory list) {
        list = new ClaimLadder.Verdict[](pay + deny + unclear + silent);
        uint256 i;
        for (uint256 k; k < pay; k++) list[i++] = ClaimLadder.Verdict.Pay;
        for (uint256 k; k < deny; k++) list[i++] = ClaimLadder.Verdict.Deny;
        for (uint256 k; k < unclear; k++) list[i++] = ClaimLadder.Verdict.Unclear;
        for (uint256 k; k < silent; k++) list[i++] = ClaimLadder.Verdict.None;
    }

    function stageOf(uint256 claimId) internal view returns (ClaimLadder.Stage) {
        return ladder.getClaim(claimId).stage;
    }

    /// Moves through windows that have no answers in them: challenge, appeal and the test window.
    function waitAndAdvance(uint256 claimId, uint256 wait) internal {
        vm.warp(block.timestamp + wait);
        ladder.advance(claimId);
    }

    function finishFromFinal(uint256 claimId) internal {
        assertEq(uint8(stageOf(claimId)), uint8(ClaimLadder.Stage.Final));
        waitAndAdvance(claimId, 1 hours);
        assertEq(uint8(stageOf(claimId)), uint8(ClaimLadder.Stage.Done));
    }

    // The panel

    function test_agreedPanelPaysAfterTheChallengeWindow() public {
        uint256 id = file(coverId);
        assertEq(seats(id, 0).length, 5);
        answer(id, 0, all(5, ClaimLadder.Verdict.Pay), 90);
        ladder.advance(id);
        assertEq(uint8(stageOf(id)), uint8(ClaimLadder.Stage.Challenge));

        uint256 before = usd.balanceOf(member);
        waitAndAdvance(id, 2 days);
        finishFromFinal(id);
        assertEq(usd.balanceOf(member), before + PAYOUT);
        assertEq(uint8(statusOf(coverId)), uint8(CoverBook.Status.PaidOut));
        assertEq(ladder.getSeat(seats(id, 0)[0], true).reputation, 101);
    }

    function test_agreedDenyEndsWithNoPayout() public {
        uint256 id = file(coverId);
        answer(id, 0, all(5, ClaimLadder.Verdict.Deny), 95);
        ladder.advance(id);
        waitAndAdvance(id, 2 days);
        finishFromFinal(id);
        assertEq(uint8(statusOf(coverId)), uint8(CoverBook.Status.Expired));
    }

    function test_aSplitPanelGoesToAJury() public {
        uint256 id = file(coverId);
        answer(id, 0, mix(4, 1, 0, 0), 90);
        ladder.advance(id);
        assertEq(uint8(stageOf(id)), uint8(ClaimLadder.Stage.Jury));
        assertEq(seats(id, 1).length, 5);
    }

    function test_aPanelThatIsNotSureGoesToAJury() public {
        uint256 id = file(coverId);
        answer(id, 0, all(5, ClaimLadder.Verdict.Pay), 60);
        ladder.advance(id);
        assertEq(uint8(stageOf(id)), uint8(ClaimLadder.Stage.Jury));
    }

    function test_tooFewMakersSkipsThePanel() public {
        // Four of the six assessors leave and three more from one maker join: five assessors, two makers.
        for (uint256 i = 2; i < 6; i++) {
            vm.prank(assessorsList[i]);
            ladder.leaveAssessors();
        }
        for (uint256 i; i < 3; i++) addAssessor(string.concat("extra", vm.toString(i)), "kestrel");
        addAssessor("sable2", "sable");
        uint256 id = file(coverId);
        // Five picked from six: kestrel and sable only, so fewer than three makers.
        assertEq(uint8(stageOf(id)), uint8(ClaimLadder.Stage.Jury));
        assertEq(seats(id, 0).length, 0);
    }

    // Challenges and juries

    function test_theClaimantChallengesADenyForFree_andTheJuryPays() public {
        uint256 id = file(coverId);
        answer(id, 0, all(5, ClaimLadder.Verdict.Deny), 90);
        ladder.advance(id);
        uint256 before = usd.balanceOf(member);
        vm.prank(member);
        ladder.challenge(id);
        assertEq(usd.balanceOf(member), before);
        assertEq(uint8(stageOf(id)), uint8(ClaimLadder.Stage.Jury));

        // 2 pay and 1 unclear beat 2 deny, because doubt goes to the claimant.
        answer(id, 1, mix(2, 2, 1, 0), 100);
        ladder.advance(id);
        assertEq(uint8(stageOf(id)), uint8(ClaimLadder.Stage.AppealWindow));
        waitAndAdvance(id, 2 days);
        finishFromFinal(id);
        assertEq(uint8(statusOf(coverId)), uint8(CoverBook.Status.PaidOut));
        // The panel was wrong, so it loses reputation but no bond.
        ClaimLadder.Seat memory seat = ladder.getSeat(seats(id, 0)[0], true);
        assertEq(seat.reputation, 98);
        assertEq(seat.bond, ASSESSOR_BOND);
    }

    function test_aTieGoesToTheClaimant_andASilentJurorLosesPartOfTheBond() public {
        uint256 id = file(coverId);
        answer(id, 0, mix(3, 2, 0, 0), 90);
        ladder.advance(id);
        answer(id, 1, mix(2, 2, 0, 1), 100);
        vm.warp(block.timestamp + 12 hours);
        ladder.advance(id);
        assertEq(uint8(ladder.getClaim(id).juryVerdict), uint8(ClaimLadder.Verdict.Pay));
        waitAndAdvance(id, 2 days);
        finishFromFinal(id);
        address silent = seats(id, 1)[4];
        assertEq(ladder.getSeat(silent, false).bond, JUROR_BOND * 95 / 100);
        assertEq(ladder.getSeat(silent, false).reputation, 95);
    }

    function test_anOutsiderWhoChallengesAndLosesPaysTheBondToThePool() public {
        uint256 id = file(coverId);
        answer(id, 0, all(5, ClaimLadder.Verdict.Pay), 90);
        ladder.advance(id);
        uint256 before = usd.balanceOf(outsider);
        vm.prank(outsider);
        ladder.challenge(id);
        assertEq(usd.balanceOf(outsider), before - CHALLENGE_BOND);

        answer(id, 1, all(5, ClaimLadder.Verdict.Pay), 100);
        ladder.advance(id);
        waitAndAdvance(id, 2 days);
        uint256 poolBefore = usd.balanceOf(address(pool));
        finishFromFinal(id);
        assertEq(usd.balanceOf(outsider), before - CHALLENGE_BOND);
        // The bond went to the pool, the payout left it.
        assertEq(usd.balanceOf(address(pool)), poolBefore + CHALLENGE_BOND - PAYOUT);
    }

    function test_theClaimantCantChallengeAPayout() public {
        uint256 id = file(coverId);
        answer(id, 0, all(5, ClaimLadder.Verdict.Pay), 90);
        ladder.advance(id);
        vm.prank(member);
        vm.expectRevert(ClaimLadder.NothingToChallenge.selector);
        ladder.challenge(id);
    }

    function test_anAppealThatWinsGetsTheBondBack() public {
        uint256 id = file(coverId);
        answer(id, 0, mix(4, 1, 0, 0), 90);
        ladder.advance(id);
        answer(id, 1, mix(1, 4, 0, 0), 100);
        ladder.advance(id);
        assertEq(uint8(ladder.getClaim(id).juryVerdict), uint8(ClaimLadder.Verdict.Deny));

        uint256 before = usd.balanceOf(member);
        vm.prank(member);
        ladder.appeal(id);
        assertEq(usd.balanceOf(member), before - APPEAL_BOND);
        assertEq(seats(id, 2).length, 7);
        // None of the first jury sit on the appeal.
        for (uint256 i; i < 7; i++) assertFalse(ladder.onSeat(id, 1, seats(id, 2)[i]));

        answer(id, 2, mix(5, 2, 0, 0), 100);
        ladder.advance(id);
        finishFromFinal(id);
        assertEq(usd.balanceOf(member), before + PAYOUT);
        assertEq(uint8(statusOf(coverId)), uint8(CoverBook.Status.PaidOut));
    }

    function test_aSilentJuryGivesThePriceBack() public {
        uint256 id = file(coverId);
        answer(id, 0, mix(4, 1, 0, 0), 90);
        ladder.advance(id);
        vm.warp(block.timestamp + 1 days);
        ladder.advance(id);
        assertEq(uint8(ladder.getClaim(id).outcome), uint8(ClaimLadder.Outcome.NoDecision));
        finishFromFinal(id);
        assertEq(uint8(statusOf(coverId)), uint8(CoverBook.Status.Refunded));
    }

    function test_theClaimantIsNeverOnTheirOwnJury() public {
        vm.prank(member);
        ladder.joinJury();
        for (uint256 n; n < 3; n++) {
            uint256 id = file(n == 0 ? coverId : newCover());
            answer(id, 0, mix(4, 1, 0, 0), 90);
            ladder.advance(id);
            for (uint256 i; i < 5; i++) assertTrue(seats(id, 1)[i] != member);
        }
    }

    // Commit and reveal

    function test_commitAndRevealRules() public {
        uint256 id = file(coverId);
        address[] memory panel = seats(id, 0);
        ClaimLadder.Verdict pay = ClaimLadder.Verdict.Pay;

        vm.prank(outsider);
        vm.expectRevert(ClaimLadder.NotSeated.selector);
        ladder.commit(id, keccak256("x"));

        commitAs(id, 0, panel[0], pay, 90);
        vm.prank(panel[0]);
        vm.expectRevert(ClaimLadder.AlreadyCommitted.selector);
        ladder.commit(id, keccak256("again"));

        // Nobody can reveal while others still have time to commit.
        vm.prank(panel[0]);
        vm.expectRevert(ClaimLadder.RevealNotOpen.selector);
        ladder.reveal(id, pay, 90, REASON, saltOf(panel[0], id, 0));

        vm.warp(block.timestamp + 12 hours);
        vm.prank(panel[1]);
        vm.expectRevert(ClaimLadder.CommitClosed.selector);
        ladder.commit(id, keccak256("late"));

        vm.prank(panel[0]);
        vm.expectRevert(ClaimLadder.BadReveal.selector);
        ladder.reveal(id, ClaimLadder.Verdict.Deny, 90, REASON, saltOf(panel[0], id, 0));
        revealAs(id, 0, panel[0], pay, 90);
    }

    function test_revealOpensEarlyOnceEveryoneHasCommitted() public {
        uint256 id = file(coverId);
        address[] memory panel = seats(id, 0);
        for (uint256 i; i < 5; i++) commitAs(id, 0, panel[i], ClaimLadder.Verdict.Pay, 90);
        for (uint256 i; i < 5; i++) revealAs(id, 0, panel[i], ClaimLadder.Verdict.Pay, 90);
        assertTrue(ladder.canAdvance(id));
    }

    function test_onlyCoverBookOpensClaims() public {
        vm.expectRevert(ClaimLadder.NotCoverBook.selector);
        ladder.open(1, member, "x");
    }

    function test_aSeatCantLeaveWhileOnAClaim() public {
        uint256 id = file(coverId);
        vm.prank(seats(id, 0)[0]);
        vm.expectRevert(ClaimLadder.Busy.selector);
        ladder.leaveAssessors();
    }

    function test_onlyMembersJoinTheJury() public {
        vm.prank(outsider);
        vm.expectRevert(ClaimLadder.NotMember.selector);
        ladder.joinJury();
    }

    // Hidden tests

    function runTest(ClaimLadder.Verdict expected, ClaimLadder.Verdict panelSays) internal returns (uint256 id) {
        uint256 cover = newCover();
        bytes32 salt = keccak256(abi.encode("salt", cover));
        bytes32 hash = ladder.testHash(cover, expected, salt);
        vm.prank(auditor);
        ladder.commitTest(hash);
        id = file(cover);
        answer(id, 0, all(5, panelSays), 90);
        ladder.advance(id);
        waitAndAdvance(id, 2 days);
        vm.prank(member);
        ladder.revealTest(id, expected, salt);
    }

    function test_aHiddenTestCatchesAWrongPanel_andThePriceGoesBack() public {
        uint256 poolBefore = usd.balanceOf(address(pool));
        uint256 memberBefore = usd.balanceOf(member);
        uint256 id = runTest(ClaimLadder.Verdict.Deny, ClaimLadder.Verdict.Pay);

        ClaimLadder.Claim memory claim = ladder.getClaim(id);
        assertTrue(claim.test);
        assertEq(uint8(claim.stage), uint8(ClaimLadder.Stage.Done));
        assertEq(uint8(statusOf(claim.coverId)), uint8(CoverBook.Status.Refunded));
        // The test wallet paid the price and got it back, with no payout.
        assertEq(usd.balanceOf(member), memberBefore);
        // Five assessors lose 10% of a 1,000 bond each, and that goes to the pool.
        assertEq(usd.balanceOf(address(pool)), poolBefore + 5 * ASSESSOR_BOND / 10);
        ClaimLadder.Seat memory seat = ladder.getSeat(seats(id, 0)[0], true);
        assertEq(seat.reputation, 80);
        assertEq(seat.testsFailed, 1);
    }

    function test_aPassedTestAddsReputation() public {
        uint256 id = runTest(ClaimLadder.Verdict.Deny, ClaimLadder.Verdict.Deny);
        ClaimLadder.Seat memory seat = ladder.getSeat(seats(id, 0)[0], true);
        assertEq(seat.reputation, 102);
        assertEq(seat.testsPassed, 1);
        assertEq(seat.bond, ASSESSOR_BOND);
    }

    function test_threeFailedTestsTakeAnAssessorOffTheList() public {
        for (uint256 i; i < 3; i++) runTest(ClaimLadder.Verdict.Deny, ClaimLadder.Verdict.Pay);
        uint256 out;
        for (uint256 i; i < assessorsList.length; i++) {
            ClaimLadder.Seat memory seat = ladder.getSeat(assessorsList[i], true);
            if (seat.testsFailed == 3) {
                assertFalse(ladder.eligible(assessorsList[i], true));
                out++;
            }
        }
        assertGt(out, 0);
    }

    function test_aJudgeWhoFailsTooManyTestsIsBenched_evenWithReputationLeft() public {
        runTest(ClaimLadder.Verdict.Deny, ClaimLadder.Verdict.Pay);
        runTest(ClaimLadder.Verdict.Deny, ClaimLadder.Verdict.Pay);
        runTest(ClaimLadder.Verdict.Pay, ClaimLadder.Verdict.Pay);
        runTest(ClaimLadder.Verdict.Deny, ClaimLadder.Verdict.Deny);
        uint256 benched;
        for (uint256 i; i < assessorsList.length; i++) {
            ClaimLadder.Seat memory seat = ladder.getSeat(assessorsList[i], true);
            // Five of six sit on each test, so at least two sat on all four.
            if (seat.testsFailed == 2 && seat.testsPassed == 2) {
                assertGe(seat.reputation, ladder.MIN_REPUTATION());
                assertGe(uint256(seat.bond) * 2, ASSESSOR_BOND);
                assertFalse(ladder.eligible(assessorsList[i], true));
                benched++;
            }
        }
        assertGe(benched, 2);
    }

    function test_aTestMustBeLockedInBeforeTheClaim() public {
        uint256 cover = newCover();
        uint256 id = file(cover);
        bytes32 salt = "late";
        vm.warp(block.timestamp + 1);
        bytes32 hash = ladder.testHash(cover, ClaimLadder.Verdict.Deny, salt);
        vm.prank(auditor);
        ladder.commitTest(hash);
        answer(id, 0, all(5, ClaimLadder.Verdict.Pay), 90);
        ladder.advance(id);
        waitAndAdvance(id, 2 days);
        vm.prank(member);
        vm.expectRevert(ClaimLadder.BadReveal.selector);
        ladder.revealTest(id, ClaimLadder.Verdict.Deny, salt);
    }

    function test_onlyTheTestWalletCanRevealATest() public {
        uint256 cover = newCover();
        bytes32 salt = "salt";
        bytes32 hash = ladder.testHash(cover, ClaimLadder.Verdict.Deny, salt);
        vm.prank(auditor);
        ladder.commitTest(hash);
        uint256 id = file(cover);
        answer(id, 0, all(5, ClaimLadder.Verdict.Pay), 90);
        ladder.advance(id);
        waitAndAdvance(id, 2 days);
        vm.prank(auditor);
        vm.expectRevert(ClaimLadder.NotHolder.selector);
        ladder.revealTest(id, ClaimLadder.Verdict.Deny, salt);
    }

    function test_onlyTheAuditorLocksInTests() public {
        vm.prank(outsider);
        vm.expectRevert(ClaimLadder.NotAuditor.selector);
        ladder.commitTest("x");
    }
}
