// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Who is a member. One person gets one wallet here: the verifier checks
/// that off chain, and only the wallet address ever goes on chain.
contract Membership is Ownable {
    address public verifier;
    uint256 public memberCount;
    mapping(address => uint40) public joinedAt;

    event VerifierSet(address verifier);
    event MemberAdded(address indexed member);
    event MemberRemoved(address indexed member);

    error NotVerifier();

    constructor(address owner_, address verifier_) Ownable(owner_) {
        verifier = verifier_;
    }

    function setVerifier(address verifier_) external onlyOwner {
        verifier = verifier_;
        emit VerifierSet(verifier_);
    }

    function add(address member) external {
        if (msg.sender != verifier) revert NotVerifier();
        if (joinedAt[member] != 0) return;
        joinedAt[member] = uint40(block.timestamp);
        memberCount++;
        emit MemberAdded(member);
    }

    function remove(address member) external {
        if (msg.sender != verifier) revert NotVerifier();
        if (joinedAt[member] == 0) return;
        joinedAt[member] = 0;
        memberCount--;
        emit MemberRemoved(member);
    }

    function isMember(address account) external view returns (bool) {
        return joinedAt[account] != 0;
    }

    /// @notice True for members who joined before `time`, so nobody can join
    /// after a vote opens and swing it.
    function wasMemberBefore(address account, uint256 time) external view returns (bool) {
        uint256 joined = joinedAt[account];
        return joined != 0 && joined < time;
    }
}
