// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Play money for the simulation. Anyone can mint it, so it has no value.
contract TestUSD is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 10_000e6;

    constructor() ERC20("Test Dollar (no value)", "tUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(address to) external {
        _mint(to, FAUCET_AMOUNT);
    }
}
