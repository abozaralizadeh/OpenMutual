// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CoverBook} from "./CoverBook.sol";
import {Membership} from "./Membership.sol";

/// @notice Claims that need judgement climb a ladder and stop at the first rung that settles them.
///
/// Round 0: a panel of AI assessors from different makers answers alone and in secret, then
/// reveals. If they all agree and are sure, that answer stands unless someone challenges it.
/// Round 1: otherwise, or after a challenge, a random jury of members decides.
/// Round 2: either side can appeal once, to a bigger jury. That answer is final.
///
/// Judges put up a bond and earn reputation for matching the final answer, the same for yes
/// and no. Hidden test claims with known answers catch judges who get things wrong, and those
/// lose part of their bond to the pool. When the wording could go either way, the claimant wins.
/// The claimant pays nothing to be heard, except a bond to appeal, which comes back if they win.
contract ClaimLadder {
    using SafeERC20 for IERC20;

    enum Verdict {
        None,
        Pay,
        Deny,
        Unclear
    }

    enum Stage {
        None,
        Panel,
        Challenge,
        Jury,
        AppealWindow,
        Appeal,
        Final,
        Done
    }

    enum Outcome {
        None,
        Pay,
        Deny,
        NoDecision
    }

    struct Settings {
        uint8 panelSize;
        uint8 minMakers;
        uint8 minConfidence;
        uint8 jurySize;
        uint8 juryQuorum;
        uint8 appealJurySize;
        uint8 appealQuorum;
        uint32 commitTime;
        uint32 revealTime;
        uint32 challengeTime;
        uint32 appealTime;
        uint32 testWindow;
        uint128 assessorBond;
        uint128 jurorBond;
        uint128 challengeBond;
        uint128 appealBond;
    }

    struct Seat {
        bool known;
        bool active;
        bytes32 maker;
        uint128 bond;
        int32 reputation;
        uint32 busy;
        uint32 testsPassed;
        uint32 testsFailed;
    }

    struct Claim {
        uint256 coverId;
        address holder;
        bytes32 evidenceHash;
        uint40 openedAt;
        Stage stage;
        uint8 round;
        Verdict panelVerdict;
        Verdict juryVerdict;
        uint40 windowEnds;
        uint40 readyAt;
        address challenger;
        address appellant;
        bool appealHeard;
        Outcome outcome;
        bool test;
    }

    struct Round {
        address[] seats;
        uint40 commitEnds;
        uint40 revealEnds;
        uint8 committed;
        uint8 revealed;
        uint8 pay;
        uint8 deny;
        uint8 unclear;
        uint8 lowestConfidence;
    }

    int32 public constant START_REPUTATION = 100;
    int32 public constant MIN_REPUTATION = 50;
    uint16 public constant MISS_SLASH_BPS = 500;
    uint16 public constant TEST_SLASH_BPS = 1_000;
    /// @notice After this many tests, a judge who gets more than a quarter of them wrong stops being picked,
    /// however much reputation the easy claims gave them.
    uint32 public constant TESTS_FOR_A_RECORD = 4;
    uint16 public constant MAX_TEST_MISS_BPS = 2_500;

    CoverBook public immutable book;
    Membership public immutable members;
    IERC20 public immutable asset;
    address public immutable pool;
    address public immutable auditor;

    Settings internal settings;
    uint256 public claimCount;
    mapping(uint256 => Claim) internal claims;
    mapping(uint256 => mapping(uint8 => Round)) internal rounds;
    mapping(uint256 => mapping(uint8 => mapping(address => bytes32))) public commits;
    mapping(uint256 => mapping(uint8 => mapping(address => Verdict))) public verdicts;
    mapping(uint256 => mapping(uint8 => mapping(address => bool))) public onSeat;
    mapping(uint256 => mapping(address => bool)) internal seatedOnClaim;

    mapping(address => Seat) internal assessors;
    mapping(address => Seat) internal jurors;
    address[] internal assessorList;
    address[] internal jurorList;
    mapping(bytes32 => uint40) public testCommits;

    event SeatJoined(address indexed who, bool assessor, bytes32 maker, uint128 bond);
    event SeatLeft(address indexed who, bool assessor, uint128 bondReturned);
    event ClaimOpened(uint256 indexed claimId, uint256 indexed coverId, address indexed holder, bytes32 evidenceHash);
    event RoundStarted(uint256 indexed claimId, uint8 round, address[] seats, uint40 commitEnds, uint40 revealEnds);
    event Committed(uint256 indexed claimId, uint8 round, address indexed who);
    event Revealed(uint256 indexed claimId, uint8 round, address indexed who, Verdict verdict, uint8 confidence, bytes32 reasonHash);
    event PanelAgreed(uint256 indexed claimId, Verdict verdict, uint40 challengeEnds);
    event PanelSplit(uint256 indexed claimId);
    event Challenged(uint256 indexed claimId, address indexed who);
    event JuryDecided(uint256 indexed claimId, uint8 round, Verdict verdict, uint8 pay, uint8 deny, uint8 unclear);
    event JuryShort(uint256 indexed claimId, uint8 round);
    event Appealed(uint256 indexed claimId, address indexed who);
    event ClaimFinal(uint256 indexed claimId, Outcome outcome, uint40 readyAt);
    event ClaimDone(uint256 indexed claimId, Outcome outcome);
    event TestCommitted(bytes32 hash);
    event TestRevealed(uint256 indexed claimId, Verdict expected, Outcome ladderOutcome);
    event Scored(uint256 indexed claimId, uint8 round, address indexed who, Verdict verdict, int32 reputation, uint128 slashed);
    event BondSettled(address indexed who, uint256 amount, bool returned);

    error BadSettings();
    error BadMaker();
    error NotMember();
    error NotSeated();
    error Busy();
    error NotCoverBook();
    error NotAuditor();
    error NotHolder();
    error WrongStage();
    error CommitClosed();
    error RevealNotOpen();
    error AlreadyCommitted();
    error NotCommitted();
    error AlreadyRevealed();
    error BadReveal();
    error WindowClosed();
    error NothingToChallenge();
    error NotReady();

    constructor(CoverBook book_, Membership members_, address auditor_, Settings memory settings_) {
        if (
            settings_.panelSize == 0 || settings_.minMakers > settings_.panelSize || settings_.minConfidence > 100
                || settings_.juryQuorum == 0 || settings_.juryQuorum > settings_.jurySize || settings_.appealQuorum == 0
                || settings_.appealQuorum > settings_.appealJurySize
        ) revert BadSettings();
        book = book_;
        members = members_;
        auditor = auditor_;
        settings = settings_;
        asset = book_.asset();
        pool = address(book_.pool());
    }

    // Seats

    /// @notice Joins the AI assessor pool, or tops up the bond after a cut. `maker` names who made the model.
    function joinAssessors(bytes32 maker) external {
        if (maker == bytes32(0)) revert BadMaker();
        Seat storage seat = assessors[msg.sender];
        seat.maker = maker;
        _join(seat, assessorList, settings.assessorBond);
        emit SeatJoined(msg.sender, true, maker, seat.bond);
    }

    /// @notice Joins the jury pool, or tops up the bond. Members only.
    function joinJury() external {
        if (!members.isMember(msg.sender)) revert NotMember();
        Seat storage seat = jurors[msg.sender];
        _join(seat, jurorList, settings.jurorBond);
        emit SeatJoined(msg.sender, false, bytes32(0), seat.bond);
    }

    function leaveAssessors() external {
        _leave(assessors[msg.sender], true);
    }

    function leaveJury() external {
        _leave(jurors[msg.sender], false);
    }

    function _join(Seat storage seat, address[] storage list, uint128 required) private {
        if (!seat.known) {
            seat.known = true;
            seat.reputation = START_REPUTATION;
            list.push(msg.sender);
        }
        seat.active = true;
        if (seat.bond < required) {
            uint128 topUp = required - seat.bond;
            seat.bond = required;
            asset.safeTransferFrom(msg.sender, address(this), topUp);
        }
    }

    function _leave(Seat storage seat, bool isAssessor) private {
        if (!seat.active) revert NotSeated();
        if (seat.busy > 0) revert Busy();
        uint128 bond = seat.bond;
        seat.active = false;
        seat.bond = 0;
        asset.safeTransfer(msg.sender, bond);
        emit SeatLeft(msg.sender, isAssessor, bond);
    }

    /// @notice Can be picked: active, a good enough reputation and test record, and at least half the bond left.
    function eligible(address who, bool isAssessor) public view returns (bool) {
        Seat storage seat = isAssessor ? assessors[who] : jurors[who];
        uint256 required = isAssessor ? settings.assessorBond : settings.jurorBond;
        uint256 tests = uint256(seat.testsPassed) + seat.testsFailed;
        bool failsTests = tests >= TESTS_FOR_A_RECORD && uint256(seat.testsFailed) * 10_000 > tests * MAX_TEST_MISS_BPS;
        return seat.active && !failsTests && seat.reputation >= MIN_REPUTATION && uint256(seat.bond) * 2 >= required;
    }

    // Opening a claim

    function open(uint256 coverId, address holder, bytes32 evidenceHash) external returns (uint256 claimId) {
        if (msg.sender != address(book)) revert NotCoverBook();
        claimId = ++claimCount;
        Claim storage claim = claims[claimId];
        claim.coverId = coverId;
        claim.holder = holder;
        claim.evidenceHash = evidenceHash;
        claim.openedAt = uint40(block.timestamp);
        emit ClaimOpened(claimId, coverId, holder, evidenceHash);
        if (!_startPanel(claimId)) _startJury(claimId, 1);
    }

    function _startPanel(uint256 claimId) private returns (bool) {
        address[] memory chosen = _pick(claimId, 0, settings.panelSize);
        // Not enough assessors, or too few makers among them, and the claim goes straight to people.
        if (chosen.length < settings.panelSize || _makers(chosen) < settings.minMakers) {
            emit PanelSplit(claimId);
            return false;
        }
        _seat(claimId, 0, chosen, Stage.Panel);
        return true;
    }

    function _startJury(uint256 claimId, uint8 round) private {
        uint8 size = round == 1 ? settings.jurySize : settings.appealJurySize;
        uint8 quorum = round == 1 ? settings.juryQuorum : settings.appealQuorum;
        address[] memory chosen = _pick(claimId, round, size);
        if (chosen.length < quorum) {
            // Too few jurors to decide. A first jury gives the price back, an appeal keeps the jury's answer.
            emit JuryShort(claimId, round);
            _final(claimId, round == 1 ? Outcome.NoDecision : _outcomeOf(claims[claimId].juryVerdict));
            return;
        }
        _seat(claimId, round, chosen, round == 1 ? Stage.Jury : Stage.Appeal);
    }

    function _seat(uint256 claimId, uint8 round, address[] memory chosen, Stage stage) private {
        Round storage r = rounds[claimId][round];
        r.seats = chosen;
        r.commitEnds = uint40(block.timestamp + settings.commitTime);
        r.revealEnds = uint40(r.commitEnds + settings.revealTime);
        r.lowestConfidence = 100;
        for (uint256 i; i < chosen.length; i++) {
            onSeat[claimId][round][chosen[i]] = true;
            seatedOnClaim[claimId][chosen[i]] = true;
            _seatOf(round, chosen[i]).busy++;
        }
        claims[claimId].stage = stage;
        claims[claimId].round = round;
        emit RoundStarted(claimId, round, chosen, r.commitEnds, r.revealEnds);
    }

    /// @dev A random pick from everyone eligible who has no part in this claim yet.
    function _pick(uint256 claimId, uint8 round, uint8 count) private view returns (address[] memory chosen) {
        bool fromAssessors = round == 0;
        address[] storage list = fromAssessors ? assessorList : jurorList;
        Claim storage claim = claims[claimId];
        address[] memory candidates = new address[](list.length);
        uint256 n;
        for (uint256 i; i < list.length; i++) {
            address who = list[i];
            if (!eligible(who, fromAssessors) || seatedOnClaim[claimId][who]) continue;
            if (who == claim.holder || who == claim.challenger || who == claim.appellant) continue;
            if (!fromAssessors && !members.isMember(who)) continue;
            candidates[n++] = who;
        }
        uint256 take = count < n ? count : n;
        chosen = new address[](take);
        uint256 seed = uint256(keccak256(abi.encode(block.prevrandao, block.timestamp, claimId, round)));
        for (uint256 i; i < take; i++) {
            uint256 j = i + seed % (n - i);
            seed = uint256(keccak256(abi.encode(seed)));
            (candidates[i], candidates[j]) = (candidates[j], candidates[i]);
            chosen[i] = candidates[i];
        }
    }

    function _makers(address[] memory chosen) private view returns (uint256 distinct) {
        for (uint256 i; i < chosen.length; i++) {
            bytes32 maker = assessors[chosen[i]].maker;
            bool seen;
            for (uint256 j; j < i && !seen; j++) seen = assessors[chosen[j]].maker == maker;
            if (!seen) distinct++;
        }
    }

    // Answering: commit in secret, then reveal

    function voteHash(uint256 claimId, uint8 round, address who, Verdict verdict, uint8 confidence, bytes32 reasonHash, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(claimId, round, who, verdict, confidence, reasonHash, salt));
    }

    function commit(uint256 claimId, bytes32 hash) external {
        Claim storage claim = claims[claimId];
        if (!_inRound(claim.stage)) revert WrongStage();
        uint8 round = claim.round;
        Round storage r = rounds[claimId][round];
        if (block.timestamp >= r.commitEnds) revert CommitClosed();
        if (!onSeat[claimId][round][msg.sender]) revert NotSeated();
        if (commits[claimId][round][msg.sender] != bytes32(0) || hash == bytes32(0)) revert AlreadyCommitted();
        commits[claimId][round][msg.sender] = hash;
        r.committed++;
        emit Committed(claimId, round, msg.sender);
    }

    /// @notice Reveals once everyone has committed or the commit time is up. A reveal counts until
    /// the claim moves on, so a late one still lands if nobody has moved it yet.
    function reveal(uint256 claimId, Verdict verdict, uint8 confidence, bytes32 reasonHash, bytes32 salt) external {
        Claim storage claim = claims[claimId];
        if (!_inRound(claim.stage)) revert WrongStage();
        uint8 round = claim.round;
        Round storage r = rounds[claimId][round];
        if (block.timestamp < r.commitEnds && r.committed < r.seats.length) revert RevealNotOpen();
        bytes32 committed = commits[claimId][round][msg.sender];
        if (committed == bytes32(0)) revert NotCommitted();
        if (verdicts[claimId][round][msg.sender] != Verdict.None) revert AlreadyRevealed();
        if (verdict == Verdict.None || confidence > 100) revert BadReveal();
        if (voteHash(claimId, round, msg.sender, verdict, confidence, reasonHash, salt) != committed) revert BadReveal();

        verdicts[claimId][round][msg.sender] = verdict;
        r.revealed++;
        if (verdict == Verdict.Pay) r.pay++;
        else if (verdict == Verdict.Deny) r.deny++;
        else r.unclear++;
        if (confidence < r.lowestConfidence) r.lowestConfidence = confidence;
        emit Revealed(claimId, round, msg.sender, verdict, confidence, reasonHash);
    }

    // Moving on

    /// @notice True when `advance` would move this claim on now.
    function canAdvance(uint256 claimId) public view returns (bool) {
        Claim storage claim = claims[claimId];
        Stage stage = claim.stage;
        if (_inRound(stage)) {
            Round storage r = rounds[claimId][claim.round];
            return r.revealed == r.seats.length || block.timestamp >= r.revealEnds;
        }
        if (stage == Stage.Challenge || stage == Stage.AppealWindow) return block.timestamp >= claim.windowEnds;
        if (stage == Stage.Final) return block.timestamp >= claim.readyAt;
        return false;
    }

    /// @notice Moves a claim to its next step. Anyone can call it, the rules decide what happens.
    function advance(uint256 claimId) external {
        if (!canAdvance(claimId)) revert NotReady();
        Claim storage claim = claims[claimId];
        Stage stage = claim.stage;
        if (stage == Stage.Panel) _closePanel(claimId);
        else if (stage == Stage.Jury || stage == Stage.Appeal) _closeJury(claimId);
        else if (stage == Stage.Challenge) _final(claimId, _outcomeOf(claim.panelVerdict));
        else if (stage == Stage.AppealWindow) _final(claimId, _outcomeOf(claim.juryVerdict));
        else _finish(claimId);
    }

    function _closePanel(uint256 claimId) private {
        Claim storage claim = claims[claimId];
        Round storage r = rounds[claimId][0];
        uint256 n = r.seats.length;
        bool agreed = r.revealed == n && r.lowestConfidence >= settings.minConfidence && (r.pay == n || r.deny == n);
        if (!agreed) {
            emit PanelSplit(claimId);
            _startJury(claimId, 1);
            return;
        }
        claim.panelVerdict = r.pay == n ? Verdict.Pay : Verdict.Deny;
        claim.stage = Stage.Challenge;
        claim.windowEnds = uint40(block.timestamp + settings.challengeTime);
        emit PanelAgreed(claimId, claim.panelVerdict, claim.windowEnds);
    }

    function _closeJury(uint256 claimId) private {
        Claim storage claim = claims[claimId];
        uint8 round = claim.round;
        Round storage r = rounds[claimId][round];
        if (r.revealed < (round == 1 ? settings.juryQuorum : settings.appealQuorum)) {
            emit JuryShort(claimId, round);
            _final(claimId, round == 1 ? Outcome.NoDecision : _outcomeOf(claim.juryVerdict));
            return;
        }
        // Doubt goes to the claimant: "unclear" counts for paying, and so does a tie.
        Verdict verdict = uint256(r.pay) + r.unclear >= r.deny ? Verdict.Pay : Verdict.Deny;
        emit JuryDecided(claimId, round, verdict, r.pay, r.deny, r.unclear);
        if (round == 2) {
            claim.appealHeard = true;
            _final(claimId, _outcomeOf(verdict));
            return;
        }
        claim.juryVerdict = verdict;
        claim.stage = Stage.AppealWindow;
        claim.windowEnds = uint40(block.timestamp + settings.appealTime);
    }

    /// @notice Sends an agreed panel answer to a jury. Free for the claimant against a "no",
    /// anyone else puts up a bond that comes back if the jury changes the answer.
    function challenge(uint256 claimId) external {
        Claim storage claim = claims[claimId];
        if (claim.stage != Stage.Challenge) revert WrongStage();
        if (block.timestamp >= claim.windowEnds) revert WindowClosed();
        if (msg.sender == claim.holder) {
            if (claim.panelVerdict != Verdict.Deny) revert NothingToChallenge();
        } else {
            asset.safeTransferFrom(msg.sender, address(this), settings.challengeBond);
        }
        claim.challenger = msg.sender;
        emit Challenged(claimId, msg.sender);
        _startJury(claimId, 1);
    }

    /// @notice Sends the jury's answer to a bigger jury, once. Needs a bond that comes back if the answer changes.
    function appeal(uint256 claimId) external {
        Claim storage claim = claims[claimId];
        if (claim.stage != Stage.AppealWindow) revert WrongStage();
        if (block.timestamp >= claim.windowEnds) revert WindowClosed();
        if (msg.sender == claim.holder && claim.juryVerdict != Verdict.Deny) revert NothingToChallenge();
        asset.safeTransferFrom(msg.sender, address(this), settings.appealBond);
        claim.appellant = msg.sender;
        emit Appealed(claimId, msg.sender);
        _startJury(claimId, 2);
    }

    function _final(uint256 claimId, Outcome outcome) private {
        Claim storage claim = claims[claimId];
        claim.stage = Stage.Final;
        claim.outcome = outcome;
        claim.readyAt = uint40(block.timestamp + settings.testWindow);
        emit ClaimFinal(claimId, outcome, claim.readyAt);
    }

    function _finish(uint256 claimId) private {
        Claim storage claim = claims[claimId];
        Outcome outcome = claim.outcome;
        claim.stage = Stage.Done;
        Verdict answer = outcome == Outcome.Pay ? Verdict.Pay : outcome == Outcome.Deny ? Verdict.Deny : Verdict.None;
        for (uint8 round; round < 3; round++) _score(claimId, round, answer, false);

        bool noDecision = outcome == Outcome.NoDecision;
        if (claim.challenger != address(0) && claim.challenger != claim.holder) {
            _settleBond(claim.challenger, settings.challengeBond, noDecision || outcome != _outcomeOf(claim.panelVerdict));
        }
        if (claim.appellant != address(0)) {
            _settleBond(claim.appellant, settings.appealBond, noDecision || !claim.appealHeard || outcome != _outcomeOf(claim.juryVerdict));
        }
        book.resolveClaim(claim.coverId, _bookOutcome(outcome));
        emit ClaimDone(claimId, outcome);
    }

    // Hidden test claims

    function testHash(uint256 coverId, Verdict expected, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(coverId, expected, salt));
    }

    /// @notice The auditor locks in the right answer to a test claim before it's filed.
    function commitTest(bytes32 hash) external {
        if (msg.sender != auditor) revert NotAuditor();
        if (testCommits[hash] != 0) revert AlreadyCommitted();
        testCommits[hash] = uint40(block.timestamp);
        emit TestCommitted(hash);
    }

    /// @notice Shows a claim was a hidden test, after its answer is final and before it pays. Only the
    /// test wallet that filed it can, so nobody can turn a real claim into a test. Judges are scored
    /// against the answer locked in beforehand, and the price goes back instead of a payout.
    function revealTest(uint256 claimId, Verdict expected, bytes32 salt) external {
        Claim storage claim = claims[claimId];
        if (msg.sender != claim.holder) revert NotHolder();
        if (claim.stage != Stage.Final) revert WrongStage();
        if (expected != Verdict.Pay && expected != Verdict.Deny) revert BadReveal();
        uint40 committedAt = testCommits[testHash(claim.coverId, expected, salt)];
        if (committedAt == 0 || committedAt > claim.openedAt) revert BadReveal();

        claim.test = true;
        claim.stage = Stage.Done;
        for (uint8 round; round < 3; round++) _score(claimId, round, expected, true);
        if (claim.challenger != address(0) && claim.challenger != claim.holder) _settleBond(claim.challenger, settings.challengeBond, true);
        if (claim.appellant != address(0)) _settleBond(claim.appellant, settings.appealBond, true);
        book.resolveClaim(claim.coverId, CoverBook.ClaimOutcome.NoQuorum);
        emit TestRevealed(claimId, expected, claim.outcome);
    }

    // Scoring

    function _score(uint256 claimId, uint8 round, Verdict answer, bool test) private {
        Round storage r = rounds[claimId][round];
        for (uint256 i; i < r.seats.length; i++) {
            address who = r.seats[i];
            Seat storage seat = _seatOf(round, who);
            seat.busy--;
            Verdict verdict = verdicts[claimId][round][who];
            int32 change;
            uint16 slashBps;
            if (verdict == Verdict.None) {
                change = -5;
                slashBps = MISS_SLASH_BPS;
            } else if (answer != Verdict.None) {
                // On a real claim "unclear" matches a payout, since doubt pays. A test has one right answer.
                bool right = verdict == answer || (!test && verdict == Verdict.Unclear && answer == Verdict.Pay);
                if (test && right) {
                    change = 2;
                    seat.testsPassed++;
                } else if (test) {
                    change = -20;
                    slashBps = TEST_SLASH_BPS;
                    seat.testsFailed++;
                } else {
                    change = right ? int32(1) : int32(-2);
                }
            }
            seat.reputation = seat.reputation + change < 0 ? int32(0) : seat.reputation + change;
            uint128 slashed = uint128(uint256(seat.bond) * slashBps / 10_000);
            if (slashed > 0) {
                seat.bond -= slashed;
                asset.safeTransfer(pool, slashed);
            }
            emit Scored(claimId, round, who, verdict, seat.reputation, slashed);
        }
    }

    function _settleBond(address to, uint256 amount, bool returned) private {
        asset.safeTransfer(returned ? to : pool, amount);
        emit BondSettled(to, amount, returned);
    }

    // Helpers

    function _inRound(Stage stage) private pure returns (bool) {
        return stage == Stage.Panel || stage == Stage.Jury || stage == Stage.Appeal;
    }

    function _seatOf(uint8 round, address who) private view returns (Seat storage) {
        return round == 0 ? assessors[who] : jurors[who];
    }

    function _outcomeOf(Verdict verdict) private pure returns (Outcome) {
        if (verdict == Verdict.Pay) return Outcome.Pay;
        if (verdict == Verdict.Deny) return Outcome.Deny;
        return Outcome.NoDecision;
    }

    function _bookOutcome(Outcome outcome) private pure returns (CoverBook.ClaimOutcome) {
        if (outcome == Outcome.Pay) return CoverBook.ClaimOutcome.Approved;
        if (outcome == Outcome.Deny) return CoverBook.ClaimOutcome.Rejected;
        return CoverBook.ClaimOutcome.NoQuorum;
    }

    // Reading

    function getSettings() external view returns (Settings memory) {
        return settings;
    }

    function getClaim(uint256 claimId) external view returns (Claim memory) {
        return claims[claimId];
    }

    function getRound(uint256 claimId, uint8 round) external view returns (Round memory) {
        return rounds[claimId][round];
    }

    function getSeat(address who, bool isAssessor) external view returns (Seat memory) {
        return isAssessor ? assessors[who] : jurors[who];
    }

    function assessorCount() external view returns (uint256) {
        return assessorList.length;
    }

    function assessorAt(uint256 index) external view returns (address) {
        return assessorList[index];
    }

    function jurorCount() external view returns (uint256) {
        return jurorList.length;
    }

    function jurorAt(uint256 index) external view returns (address) {
        return jurorList[index];
    }
}
