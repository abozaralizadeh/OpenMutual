// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Membership} from "./Membership.sol";

/// @notice Members vote on setting changes. One member, one vote, whatever they
/// hold in the pool. Passed changes go through the timelock, so people can react.
contract MemberGovernor {
    struct Proposal {
        address proposer;
        address target;
        uint40 openedAt;
        uint40 endsAt;
        uint32 yes;
        uint32 no;
        uint32 needed;
        bool queued;
        bytes data;
        bytes32 descriptionHash;
    }

    Membership public immutable members;
    TimelockController public immutable timelock;
    uint32 public immutable votingPeriod;
    uint16 public immutable quorumBps;
    uint32 public immutable minVotes;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    /// @notice Members can only change what's on this list, set at deployment.
    mapping(address => mapping(bytes4 => bool)) public allowedCall;

    event ProposalOpened(uint256 indexed id, address indexed proposer, address target, bytes data, bytes32 descriptionHash, uint40 endsAt, uint32 votesNeeded);
    event ProposalVoted(uint256 indexed id, address indexed member, bool support);
    event ProposalQueued(uint256 indexed id, uint256 executableAt);
    event ProposalExecuted(uint256 indexed id);

    error NotAllowed();
    error NotMember();
    error NotEligible();
    error AlreadyVoted();
    error VotingClosed();
    error VotingOpen();
    error DidNotPass();
    error AlreadyQueued();
    error NotQueued();

    constructor(
        Membership members_,
        TimelockController timelock_,
        uint32 votingPeriod_,
        uint16 quorumBps_,
        uint32 minVotes_,
        address[] memory targets,
        bytes4[] memory selectors
    ) {
        members = members_;
        timelock = timelock_;
        votingPeriod = votingPeriod_;
        quorumBps = quorumBps_;
        minVotes = minVotes_;
        for (uint256 i; i < targets.length; i++) {
            allowedCall[targets[i]][selectors[i]] = true;
        }
    }

    function propose(address target, bytes calldata data, bytes32 descriptionHash) external returns (uint256 id) {
        if (!members.isMember(msg.sender)) revert NotMember();
        if (data.length < 4 || !allowedCall[target][bytes4(data[:4])]) revert NotAllowed();
        uint256 byShare = members.memberCount() * quorumBps / 10_000;
        uint32 needed = uint32(byShare > minVotes ? byShare : minVotes);
        uint40 endsAt = uint40(block.timestamp + votingPeriod);
        id = ++proposalCount;
        proposals[id] = Proposal(msg.sender, target, uint40(block.timestamp), endsAt, 0, 0, needed, false, data, descriptionHash);
        emit ProposalOpened(id, msg.sender, target, data, descriptionHash, endsAt, needed);
    }

    function vote(uint256 id, bool support) external {
        Proposal storage proposal = proposals[id];
        if (block.timestamp >= proposal.endsAt) revert VotingClosed();
        if (!members.wasMemberBefore(msg.sender, proposal.openedAt)) revert NotEligible();
        if (hasVoted[id][msg.sender]) revert AlreadyVoted();
        hasVoted[id][msg.sender] = true;
        if (support) proposal.yes++;
        else proposal.no++;
        emit ProposalVoted(id, msg.sender, support);
    }

    function queue(uint256 id) external {
        Proposal storage proposal = proposals[id];
        if (proposal.endsAt == 0 || block.timestamp < proposal.endsAt) revert VotingOpen();
        if (proposal.queued) revert AlreadyQueued();
        if (proposal.yes + proposal.no < proposal.needed || proposal.yes <= proposal.no) revert DidNotPass();
        proposal.queued = true;
        uint256 delay = timelock.getMinDelay();
        timelock.schedule(proposal.target, 0, proposal.data, bytes32(0), bytes32(id), delay);
        emit ProposalQueued(id, block.timestamp + delay);
    }

    function execute(uint256 id) external {
        Proposal storage proposal = proposals[id];
        if (!proposal.queued) revert NotQueued();
        timelock.execute(proposal.target, 0, proposal.data, bytes32(0), bytes32(id));
        emit ProposalExecuted(id);
    }
}
