// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Collects event results from several independent reporters.
/// A result counts once enough reporters agree on the outcome, so one wrong or
/// dishonest source can't decide a payout. The guardian then has a short window
/// to reject a bad result before it can be used.
contract ResultOracle is Ownable {
    enum State {
        Unknown,
        Waiting,
        InChallengeWindow,
        Final
    }

    struct EventData {
        bool registered;
        bool decided;
        bool triggered;
        uint8 yesVotes;
        uint8 noVotes;
        uint32 threshold;
        uint32 round;
        uint32 value;
        uint40 yesFrom;
        uint40 noFrom;
        uint40 decidedAt;
    }

    address public registrar;
    address public guardian;
    uint8 public quorum;
    uint32 public challengeWindow;
    uint32 public reporterCount;

    mapping(address => bool) public isReporter;
    mapping(bytes32 => EventData) public events;
    mapping(bytes32 => mapping(uint32 => mapping(address => bool))) private voted;

    event ReporterSet(address indexed reporter, bool active);
    event QuorumSet(uint8 quorum);
    event ChallengeWindowSet(uint32 challengeWindow);
    event RegistrarSet(address registrar);
    event GuardianSet(address guardian);
    event EventRegistered(bytes32 indexed key, uint32 threshold, uint40 yesFrom, uint40 noFrom);
    event ResultReported(bytes32 indexed key, uint32 indexed round, address indexed reporter, uint32 value, bool triggered);
    event ResultDecided(bytes32 indexed key, bool triggered, uint32 value);
    event ResultRejected(bytes32 indexed key, uint32 newRound);

    error NotRegistrar();
    error NotGuardian();
    error NotReporter();
    error UnknownEvent();
    error AlreadyDecided();
    error AlreadyReported();
    error TooEarly();
    error NotInChallengeWindow();
    error BadQuorum();

    constructor(address owner_, address guardian_, uint8 quorum_, uint32 challengeWindow_) Ownable(owner_) {
        if (quorum_ == 0) revert BadQuorum();
        guardian = guardian_;
        quorum = quorum_;
        challengeWindow = challengeWindow_;
    }

    function setRegistrar(address registrar_) external onlyOwner {
        registrar = registrar_;
        emit RegistrarSet(registrar_);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function setReporter(address reporter, bool active) external onlyOwner {
        if (isReporter[reporter] == active) return;
        isReporter[reporter] = active;
        if (active) reporterCount++;
        else reporterCount--;
        emit ReporterSet(reporter, active);
    }

    function setQuorum(uint8 quorum_) external onlyOwner {
        if (quorum_ == 0) revert BadQuorum();
        quorum = quorum_;
        emit QuorumSet(quorum_);
    }

    function setChallengeWindow(uint32 challengeWindow_) external onlyOwner {
        challengeWindow = challengeWindow_;
        emit ChallengeWindowSet(challengeWindow_);
    }

    /// @notice Sets the rule for an event. Safe to call again, the first call wins.
    /// @param yesFrom earliest time a triggered result can be reported
    /// @param noFrom earliest time a not triggered result can be reported
    function register(bytes32 key, uint32 threshold, uint40 yesFrom, uint40 noFrom) external {
        if (msg.sender != registrar) revert NotRegistrar();
        EventData storage data = events[key];
        if (data.registered) return;
        data.registered = true;
        data.threshold = threshold;
        data.yesFrom = yesFrom;
        data.noFrom = noFrom;
        emit EventRegistered(key, threshold, yesFrom, noFrom);
    }

    function report(bytes32 key, uint32 value) external {
        if (!isReporter[msg.sender]) revert NotReporter();
        EventData storage data = events[key];
        if (!data.registered) revert UnknownEvent();
        if (data.decided) revert AlreadyDecided();
        if (voted[key][data.round][msg.sender]) revert AlreadyReported();

        bool isYes = value >= data.threshold;
        if (block.timestamp < (isYes ? data.yesFrom : data.noFrom)) revert TooEarly();

        voted[key][data.round][msg.sender] = true;
        uint8 votes = isYes ? ++data.yesVotes : ++data.noVotes;
        emit ResultReported(key, data.round, msg.sender, value, isYes);

        if (votes >= quorum) {
            data.decided = true;
            data.triggered = isYes;
            data.value = value;
            data.decidedAt = uint40(block.timestamp);
            emit ResultDecided(key, isYes, value);
        }
    }

    /// @notice Throws away a decided result and starts the vote again.
    function reject(bytes32 key) external {
        if (msg.sender != guardian) revert NotGuardian();
        if (state(key) != State.InChallengeWindow) revert NotInChallengeWindow();
        EventData storage data = events[key];
        data.decided = false;
        data.triggered = false;
        data.yesVotes = 0;
        data.noVotes = 0;
        data.value = 0;
        data.decidedAt = 0;
        data.round++;
        emit ResultRejected(key, data.round);
    }

    function state(bytes32 key) public view returns (State) {
        EventData storage data = events[key];
        if (!data.registered) return State.Unknown;
        if (!data.decided) return State.Waiting;
        if (block.timestamp < uint256(data.decidedAt) + challengeWindow) return State.InChallengeWindow;
        return State.Final;
    }

    function triggered(bytes32 key) external view returns (bool) {
        return events[key].triggered;
    }

    function hasReported(bytes32 key, address reporter) external view returns (bool) {
        return voted[key][events[key].round][reporter];
    }
}
