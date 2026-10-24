// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PackedUserOperation} from "./interfaces/PackedUserOperation.sol";

/// @title AgentPaymaster
/// @notice ERC-4337 v0.7 paymaster with a per-agent rolling gas sponsorship budget.
/// @dev `paymasterAndData` is encoded as `(address agent,uint48 validUntil,uint48 validAfter,uint256 declaredGas)`.
contract AgentPaymaster {
    enum PostOpMode {
        opSucceeded,
        opReverted,
        postOpReverted
    }

    error UnauthorizedEntryPoint(address caller);
    error UnauthorizedOwner(address caller);
    error InvalidAddress();
    error InvalidPaymasterData();
    error AgentNotRegistered(address account, address agent);
    error PaymasterDailyGasLimitExceeded(address agent, uint256 projected, uint256 limit);
    error InvalidGasDeclaration();
    error InvalidValidityWindow(uint48 validUntil, uint48 validAfter);
    error InvalidContext();
    error InsufficientReservedGas(address agent, uint256 requested, uint256 reserved);
    error WithdrawFailed();

    address public immutable entryPoint;
    address public owner;
    uint256 public immutable defaultDailyGasLimit;

    mapping(address account => address agent) public accountAgent;
    mapping(address agent => uint256 limit) public agentDailyGasLimit;
    mapping(address agent => uint256 spent) public agentSpentGas;
    mapping(address agent => uint256 reserved) public agentReservedGas;
    mapping(address agent => uint256 windowStart) public agentWindowStart;

    event OwnerUpdated(address indexed previousOwner, address indexed newOwner);
    event AgentRegistered(address indexed account, address indexed agent, uint256 dailyGasLimit);
    event AgentUnregistered(address indexed account, address indexed agent);
    event SponsorshipReserved(bytes32 indexed userOpHash, address indexed agent, uint256 declaredGas);
    event SponsorshipSettled(bytes32 indexed userOpHash, address indexed agent, uint256 actualGas, uint256 declaredGas);
    event DailyGasLimitUpdated(address indexed agent, uint256 dailyGasLimit);

    modifier onlyOwner() {
        if (msg.sender != owner) revert UnauthorizedOwner(msg.sender);
        _;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != entryPoint) revert UnauthorizedEntryPoint(msg.sender);
        _;
    }

    constructor(address entryPoint_, address owner_, uint256 defaultDailyGasLimit_) payable {
        if (entryPoint_ == address(0) || owner_ == address(0)) revert InvalidAddress();
        if (defaultDailyGasLimit_ == 0) revert InvalidGasDeclaration();
        entryPoint = entryPoint_;
        owner = owner_;
        defaultDailyGasLimit = defaultDailyGasLimit_;
    }

    /// @notice Changes the paymaster administrator.
    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Registers the agent permitted to sponsor operations from an account.
    function registerAgent(address account, address agent, uint256 dailyGasLimit) external onlyOwner {
        if (account == address(0) || agent == address(0)) revert InvalidAddress();
        if (dailyGasLimit == 0) revert InvalidGasDeclaration();
        accountAgent[account] = agent;
        agentDailyGasLimit[agent] = dailyGasLimit;
        if (agentWindowStart[agent] == 0) agentWindowStart[agent] = block.timestamp;
        emit AgentRegistered(account, agent, dailyGasLimit);
    }

    /// @notice Removes an account-to-agent sponsorship binding.
    function unregisterAgent(address account) external onlyOwner {
        address agent = accountAgent[account];
        delete accountAgent[account];
        emit AgentUnregistered(account, agent);
    }

    /// @notice Updates the rolling gas budget for an already registered agent.
    function setAgentDailyGasLimit(address agent, uint256 dailyGasLimit) external onlyOwner {
        if (agent == address(0) || dailyGasLimit == 0) revert InvalidGasDeclaration();
        agentDailyGasLimit[agent] = dailyGasLimit;
        emit DailyGasLimitUpdated(agent, dailyGasLimit);
    }

    /// @notice Reserves the declared gas budget before EntryPoint execution.
    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) external onlyEntryPoint returns (bytes memory context, uint256 validationData) {
        maxCost;
        (address agent, uint48 validUntil, uint48 validAfter, uint256 declaredGas) = _decodePaymasterData(userOp.paymasterAndData);
        if (accountAgent[userOp.sender] != agent || agentDailyGasLimit[agent] == 0) {
            revert AgentNotRegistered(userOp.sender, agent);
        }
        if (declaredGas == 0) revert InvalidGasDeclaration();
        if (validUntil != 0 && validUntil <= validAfter) revert InvalidValidityWindow(validUntil, validAfter);
        _refresh(agent);
        uint256 limit = agentDailyGasLimit[agent];
        uint256 projected = agentSpentGas[agent] + agentReservedGas[agent] + declaredGas;
        if (projected > limit) revert PaymasterDailyGasLimitExceeded(agent, projected, limit);
        agentReservedGas[agent] += declaredGas;
        context = abi.encode(agent, declaredGas, userOpHash);
        validationData = _packValidationData(validUntil, validAfter);
        emit SponsorshipReserved(userOpHash, agent, declaredGas);
    }

    /// @notice Settles reserved gas and keeps the actual billed gas inside the budget.
    function postOp(
        PostOpMode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) external onlyEntryPoint {
        (address agent, uint256 declaredGas, bytes32 userOpHash) = abi.decode(context, (address, uint256, bytes32));
        _refresh(agent);
        if (agentReservedGas[agent] < declaredGas) revert InsufficientReservedGas(agent, declaredGas, agentReservedGas[agent]);
        uint256 actualGas = declaredGas;
        if (actualUserOpFeePerGas != 0) {
            uint256 measuredGas = actualGasCost / actualUserOpFeePerGas;
            if (measuredGas < actualGas) actualGas = measuredGas;
        }
        agentReservedGas[agent] -= declaredGas;
        agentSpentGas[agent] += actualGas;
        emit SponsorshipSettled(userOpHash, agent, actualGas, declaredGas);
    }

    /// @notice Deposits native currency into the canonical EntryPoint.
    function deposit() external payable onlyOwner {
        IEntryPointDeposit(entryPoint).depositTo{value: msg.value}(address(this));
    }

    /// @notice Withdraws native currency from the canonical EntryPoint.
    function withdrawTo(address payable recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) revert InvalidAddress();
        IEntryPointDeposit(entryPoint).withdrawTo(recipient, amount);
    }

    receive() external payable {}

    function _decodePaymasterData(bytes calldata data)
        internal
        pure
        returns (address agent, uint48 validUntil, uint48 validAfter, uint256 declaredGas)
    {
        if (data.length != 128) revert InvalidPaymasterData();
        (agent, validUntil, validAfter, declaredGas) = abi.decode(data, (address, uint48, uint48, uint256));
    }

    /// @notice Decodes the paymaster-specific payload format.
    function decodePaymasterData(bytes calldata data)
        external
        pure
        returns (address agent, uint48 validUntil, uint48 validAfter, uint256 declaredGas)
    {
        (agent, validUntil, validAfter, declaredGas) = abi.decode(data, (address, uint48, uint48, uint256));
    }

    function _refresh(address agent) internal {
        uint256 start = agentWindowStart[agent];
        if (start == 0 || block.timestamp >= start + 24 hours) {
            agentWindowStart[agent] = block.timestamp;
            agentSpentGas[agent] = 0;
            agentReservedGas[agent] = 0;
        }
    }

    function _packValidationData(uint48 validUntil, uint48 validAfter) internal pure returns (uint256) {
        return (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }
}

interface IEntryPointDeposit {
    function depositTo(address account) external payable;
    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external;
}
