// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UserOperation} from "./UserOperation.sol";
import {PackedUserOperation} from "./PackedUserOperation.sol";

/// @notice Minimal ERC-4337 account validation interface supporting v0.6 and v0.7.
interface IAccount {
    function validateUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData);

    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData);
}
