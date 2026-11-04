// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

/// @notice A small M of N wallet for the team. It holds no money. Its only job
/// is to send setting changes to the timelock, so no single key can change a rule.
contract TeamMultisig {
    struct Action {
        address target;
        bool executed;
        uint32 confirmations;
        bytes data;
    }

    uint256 public immutable required;
    mapping(address => bool) public isSigner;
    Action[] public actions;
    mapping(uint256 => mapping(address => bool)) public confirmed;

    event Submitted(uint256 indexed id, address indexed signer, address target, bytes data);
    event Confirmed(uint256 indexed id, address indexed signer);
    event Executed(uint256 indexed id);

    error NotSigner();
    error BadSetup();
    error AlreadyConfirmed();
    error AlreadyExecuted();
    error NotEnoughConfirmations();
    error CallFailed(bytes reason);

    modifier onlySigner() {
        if (!isSigner[msg.sender]) revert NotSigner();
        _;
    }

    constructor(address[] memory signers, uint256 required_) {
        if (required_ == 0 || required_ > signers.length) revert BadSetup();
        required = required_;
        for (uint256 i; i < signers.length; i++) {
            if (signers[i] == address(0) || isSigner[signers[i]]) revert BadSetup();
            isSigner[signers[i]] = true;
        }
    }

    function actionCount() external view returns (uint256) {
        return actions.length;
    }

    function submit(address target, bytes calldata data) external onlySigner returns (uint256 id) {
        id = actions.length;
        actions.push(Action(target, false, 0, data));
        emit Submitted(id, msg.sender, target, data);
        confirm(id);
    }

    function confirm(uint256 id) public onlySigner {
        if (actions[id].executed) revert AlreadyExecuted();
        if (confirmed[id][msg.sender]) revert AlreadyConfirmed();
        confirmed[id][msg.sender] = true;
        actions[id].confirmations++;
        emit Confirmed(id, msg.sender);
    }

    function execute(uint256 id) external onlySigner {
        Action storage action = actions[id];
        if (action.executed) revert AlreadyExecuted();
        if (action.confirmations < required) revert NotEnoughConfirmations();
        action.executed = true;
        (bool ok, bytes memory reason) = action.target.call(action.data);
        if (!ok) revert CallFailed(reason);
        emit Executed(id);
    }
}
