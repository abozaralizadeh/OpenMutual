// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {CoverBook} from "./CoverBook.sol";
import {Membership} from "./Membership.sol";

/// @notice Members vote on claims that need a human decision. One member, one vote.
/// If too few members vote, the holder gets the premium back, so silence can't
/// be used to turn a claim down.
contract ClaimReview {
    struct Claim {
        uint256 coverId;
        address holder;
        bytes32 evidenceHash;
        uint40 openedAt;
        uint40 endsAt;
        uint32 yes;
        uint32 no;
        uint32 needed;
        bool finished;
    }

    CoverBook public immutable book;
    Membership public immutable members;
    uint32 public immutable votingPeriod;
    uint16 public immutable quorumBps;
    uint32 public immutable minVotes;

    uint256 public claimCount;
    mapping(uint256 => Claim) public claims;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    event ClaimOpened(uint256 indexed claimId, uint256 indexed coverId, bytes32 evidenceHash, uint40 endsAt, uint32 votesNeeded);
    event ClaimVoted(uint256 indexed claimId, address indexed member, bool approve);
    event ClaimFinished(uint256 indexed claimId, CoverBook.ClaimOutcome outcome, uint32 yes, uint32 no);

    error NotCoverBook();
    error NotEligible();
    error OwnClaim();
    error AlreadyVoted();
    error VotingClosed();
    error VotingOpen();
    error Finished();

    constructor(CoverBook book_, Membership members_, uint32 votingPeriod_, uint16 quorumBps_, uint32 minVotes_) {
        book = book_;
        members = members_;
        votingPeriod = votingPeriod_;
        quorumBps = quorumBps_;
        minVotes = minVotes_;
    }

    function open(uint256 coverId, address holder, bytes32 evidenceHash) external returns (uint256 claimId) {
        if (msg.sender != address(book)) revert NotCoverBook();
        uint256 byShare = members.memberCount() * quorumBps / 10_000;
        uint32 needed = uint32(byShare > minVotes ? byShare : minVotes);
        uint40 endsAt = uint40(block.timestamp + votingPeriod);
        claimId = ++claimCount;
        claims[claimId] = Claim(coverId, holder, evidenceHash, uint40(block.timestamp), endsAt, 0, 0, needed, false);
        emit ClaimOpened(claimId, coverId, evidenceHash, endsAt, needed);
    }

    function vote(uint256 claimId, bool approve) external {
        Claim storage claim = claims[claimId];
        if (block.timestamp >= claim.endsAt) revert VotingClosed();
        if (!members.wasMemberBefore(msg.sender, claim.openedAt)) revert NotEligible();
        if (msg.sender == claim.holder) revert OwnClaim();
        if (hasVoted[claimId][msg.sender]) revert AlreadyVoted();
        hasVoted[claimId][msg.sender] = true;
        if (approve) claim.yes++;
        else claim.no++;
        emit ClaimVoted(claimId, msg.sender, approve);
    }

    function finish(uint256 claimId) external {
        Claim storage claim = claims[claimId];
        if (claim.endsAt == 0 || block.timestamp < claim.endsAt) revert VotingOpen();
        if (claim.finished) revert Finished();
        claim.finished = true;

        CoverBook.ClaimOutcome outcome;
        if (claim.yes + claim.no < claim.needed) outcome = CoverBook.ClaimOutcome.NoQuorum;
        else if (claim.yes > claim.no) outcome = CoverBook.ClaimOutcome.Approved;
        else outcome = CoverBook.ClaimOutcome.Rejected;

        book.resolveClaim(claim.coverId, outcome);
        emit ClaimFinished(claimId, outcome, claim.yes, claim.no);
    }
}
