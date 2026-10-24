// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccount} from "./interfaces/IAccount.sol";
import {UserOperation} from "./interfaces/UserOperation.sol";
import {PackedUserOperation} from "./interfaces/PackedUserOperation.sol";
import {PolicyEngine} from "./PolicyEngine.sol";
import {SignatureLib} from "./libraries/SignatureLib.sol";
import {AnomalyGuard} from "./AnomalyGuard.sol";
import {GuardianRecoveryModule} from "./GuardianRecoveryModule.sol";

/// @title AgentSmartAccount
/// @notice ERC-4337 smart account with a root owner and a constrained session key.
/// @dev The account accepts both ERC-4337 v0.6 and v0.7 validation structs. Agent
///      execution is limited to the exact `execute` payload validated by PolicyEngine.
contract AgentSmartAccount is IAccount {
    using SignatureLib for bytes32;

    error UnauthorizedEntryPoint(address caller);
    error UnauthorizedOwner(address caller);
    error InvalidAddress();
    error InvalidAuthorization();
    error InvalidSender(address sender);
    error InvalidSignerType(uint8 signerType);
    error InvalidNonce(uint192 key, uint64 expected, uint64 supplied);
    error NonceOverflow(uint192 key);
    error InvalidExecutionSelector(bytes4 selector);
    error PolicyViolation_MalformedCalldata();
    error ExecutionFailed(bytes reason);
    error PrefundPaymentFailed();
    error AgentKeyFrozen();
    error UnauthorizedAnomalyGuard(address caller);
    error UnauthorizedGuardianRecovery(address caller);

    uint8 private constant _OWNER_SIGNER = 0;
    uint8 private constant _AGENT_SIGNER = 1;

    /// @notice Selector for execute(bytes32,address,uint256,bytes).
    bytes4 public constant EXECUTE_SELECTOR = bytes4(keccak256("execute(bytes32,address,uint256,bytes)"));
    bytes4 private constant _ERC20_TRANSFER_SELECTOR = bytes4(keccak256("transfer(address,uint256)"));
    bytes4 private constant _ERC20_APPROVE_SELECTOR = bytes4(keccak256("approve(address,uint256)"));
    bytes4 private constant _ERC20_TRANSFER_FROM_SELECTOR = bytes4(keccak256("transferFrom(address,address,uint256)"));
    bytes4 private constant _PAY_CREDITS_SELECTOR = bytes4(keccak256("payCredits(address,uint256)"));

    address public immutable entryPoint;
    address public owner;
    PolicyEngine public immutable policyEngine;
    AnomalyGuard public immutable anomalyGuard;
    GuardianRecoveryModule public immutable guardianRecovery;
    enum AgentStatus {
        ACTIVE,
        FROZEN
    }
    AgentStatus public agentStatus;
    mapping(uint192 nonceKey => uint64 sequence) public nextSequence;

    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);
    event Executed(bytes32 indexed userOpHash, address indexed target, uint256 value, bytes32 callDataHash);

    modifier onlyOwner() {
        if (msg.sender != owner) revert UnauthorizedOwner(msg.sender);
        _;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != entryPoint) revert UnauthorizedEntryPoint(msg.sender);
        _;
    }

    /// @param entryPoint_ The canonical ERC-4337 EntryPoint for this deployment.
    /// @param owner_ The root EOA with unrestricted administrative and execution authority.
    /// @param agentKey_ Initial session key. Pass address(0) to install it later.
    /// @param agentValidUntil_ Initial strict expiry. Ignored when agentKey_ is zero.
    constructor(address entryPoint_, address owner_, address agentKey_, uint48 agentValidUntil_) payable {
        if (entryPoint_ == address(0) || owner_ == address(0)) revert InvalidAddress();
        entryPoint = entryPoint_;
        owner = owner_;
        policyEngine = new PolicyEngine(address(this), owner_);
        anomalyGuard = new AnomalyGuard(address(this), owner_);
        guardianRecovery = new GuardianRecoveryModule(address(this), owner_);
        agentStatus = AgentStatus.ACTIVE;
        if (agentKey_ != address(0)) {
            policyEngine.setAgentKey(agentKey_, agentValidUntil_);
        }
    }

    /// @notice Validates an ERC-4337 v0.6 UserOperation.
    function validateUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external override onlyEntryPoint returns (uint256 validationData) {
        validationData = _validateUserOp(userOp.sender, userOp.nonce, userOp.callData, userOp.signature, userOpHash);
        _payPrefund(missingAccountFunds);
    }

    /// @notice Validates an ERC-4337 v0.7 PackedUserOperation.
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external override onlyEntryPoint returns (uint256 validationData) {
        validationData = _validateUserOp(userOp.sender, userOp.nonce, userOp.callData, userOp.signature, userOpHash);
        _payPrefund(missingAccountFunds);
    }

    /// @notice Executes the exact call whose hash was authorized during validation.
    /// @dev The EntryPoint path must consume a PolicyEngine reservation. The root owner
    ///      path intentionally bypasses the agent policy and can execute arbitrary calls.
    function execute(bytes32 userOpHash, address target, uint256 value, bytes calldata data) external payable {
        bool fromEntryPoint = msg.sender == entryPoint;
        if (!fromEntryPoint && msg.sender != owner) revert UnauthorizedOwner(msg.sender);

        bytes4 selector = _selectorOf(data);
        (uint256 tokenAmount, address recipient) = _tokenAmountAndRecipient(data, selector);
        if (fromEntryPoint) {
            if (policyEngine.ownerAuthorizedUserOps(userOpHash)) {
                policyEngine.consumeOwnerUserOp(userOpHash);
            } else {
                policyEngine.consumePendingApproval(
                    userOpHash,
                    target,
                    selector,
                    value,
                    tokenAmount,
                    keccak256(data)
                );
            }
        }

        (bool success, bytes memory result) = target.call{value: value}(data);
        if (!success) _bubbleRevert(result);
        emit Executed(userOpHash, target, value, keccak256(data));
        // Silence the compiler's unused-variable warning while preserving the decoded
        // recipient as an explicit part of the byte-level validation path.
        recipient;
    }

    /// @notice Transfers ownership and updates the policy engine's EIP-712 signer.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
        policyEngine.setOwner(newOwner);
        anomalyGuard.setOwner(newOwner);
        guardianRecovery.synchronizeOwner(newOwner);
    }

    /// @notice Installs or rotates the session key.
    function setAgentKey(address newAgentKey, uint48 validUntil) external onlyOwner {
        policyEngine.setAgentKey(newAgentKey, validUntil);
    }

    /// @notice Revokes the session key without waiting for its expiry.
    function revokeAgentKey() external onlyOwner {
        policyEngine.revokeAgentKey();
    }

    /// @notice Updates per-operation and 24-hour velocity caps.
    function setLimits(uint256 maxPerTxValueWei, uint256 dailyLimitWei) external onlyOwner {
        policyEngine.setLimits(maxPerTxValueWei, dailyLimitWei);
    }

    /// @notice Updates owner-approval escalation behavior.
    function setOwnerApprovalPolicy(bool required, uint256 threshold) external onlyOwner {
        policyEngine.setOwnerApprovalPolicy(required, threshold);
    }

    /// @notice Updates a target allowlist entry.
    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        policyEngine.setAllowedTarget(target, allowed);
    }

    /// @notice Updates a selector allowlist entry.
    function setAllowedSelector(address target, bytes4 selector, bool allowed) external onlyOwner {
        policyEngine.setAllowedSelector(target, selector, allowed);
    }

    /// @notice Updates a direct-transfer recipient allowlist entry.
    function setAllowedRecipient(address recipient, bool allowed) external onlyOwner {
        policyEngine.setAllowedRecipient(recipient, allowed);
    }

    /// @notice Registers the five trusted guardians for social recovery.
    function configureGuardians(address[5] calldata guardians) external onlyOwner {
        guardianRecovery.configureGuardians(guardians);
    }

    /// @notice Configures on-chain anomaly detection sensitivity and schedule.
    function setAnomalyConfiguration(
        uint256 freezeThreshold,
        uint256 alphaBps,
        uint256 baselineTpmScaled,
        uint256 velocityMultiplierBps,
        uint256 zScoreThresholdScaled,
        uint8 expectedStartHourUtc,
        uint8 expectedEndHourUtc
    ) external onlyOwner {
        anomalyGuard.setConfiguration(freezeThreshold, alphaBps, baselineTpmScaled, velocityMultiplierBps, zScoreThresholdScaled, expectedStartHourUtc, expectedEndHourUtc);
    }

    /// @notice Sets the authorized anomaly sentinel watcher.
    function setAnomalySentinel(address sentinel) external onlyOwner {
        anomalyGuard.setSentinel(sentinel);
    }

    /// @notice Adds or removes an interaction from the normal anomaly profile.
    function setKnownInteraction(address target, bytes4 selector, bool known) external onlyOwner {
        anomalyGuard.setKnownInteraction(target, selector, known);
    }

    /// @notice Adds or removes a recipient from the normal anomaly profile.
    function setKnownRecipient(address recipient, bool known) external onlyOwner {
        anomalyGuard.setKnownRecipient(recipient, known);
    }

    /// @notice Owner-controlled recovery from an anomaly freeze.
    function unfreezeAgent() external onlyOwner {
        anomalyGuard.unfreeze();
        agentStatus = AgentStatus.ACTIVE;
    }

    /// @notice Owner or sentinel callback used by AnomalyGuard for persistent freezes.
    function freezeFromAnomalyGuard() external {
        if (msg.sender != address(anomalyGuard)) revert UnauthorizedAnomalyGuard(msg.sender);
        agentStatus = AgentStatus.FROZEN;
    }

    /// @notice Owner-controlled emergency freeze.
    function freezeAgent(bytes32 reason) external onlyOwner {
        anomalyGuard.freeze(reason);
        agentStatus = AgentStatus.FROZEN;
    }

    /// @notice Applies an owner rotation after guardian quorum and timelock execution.
    function recoverOwnerFromGuardians(address newOwner) external {
        if (msg.sender != address(guardianRecovery)) revert UnauthorizedGuardianRecovery(msg.sender);
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
        policyEngine.setOwner(newOwner);
        anomalyGuard.setOwner(newOwner);
        guardianRecovery.synchronizeOwner(newOwner);
    }

    /// @notice Applies an agent-key rotation after guardian quorum and timelock execution.
    function recoverAgentFromGuardians(address newAgent) external {
        if (msg.sender != address(guardianRecovery)) revert UnauthorizedGuardianRecovery(msg.sender);
        if (newAgent == address(0)) revert InvalidAddress();
        policyEngine.setAgentKey(newAgent, type(uint48).max);
        anomalyGuard.unfreeze();
        agentStatus = AgentStatus.ACTIVE;
    }

    /// @notice Accepts native currency deposits for UserOperation execution and prefunding.
    receive() external payable {}

    function _validateUserOp(
        address sender,
        uint256 nonce,
        bytes calldata callData,
        bytes calldata authorization,
        bytes32 userOpHash
    ) internal returns (uint256 validationData) {
        if (sender != address(this)) revert InvalidSender(sender);
        if (callData.length < 4) revert PolicyViolation_MalformedCalldata();
        (bytes32 encodedHash, address target, uint256 value, bytes calldata data) = _decodeExecution(callData);
        if (encodedHash != userOpHash) revert PolicyViolation_MalformedCalldata();

        (uint192 nonceKey, uint64 sequence) = _unpackNonce(nonce);
        uint64 expected = nextSequence[nonceKey];
        if (sequence != expected) revert InvalidNonce(nonceKey, expected, sequence);
        if (expected == type(uint64).max) revert NonceOverflow(nonceKey);
        nextSequence[nonceKey] = expected + 1;

        (uint8 signerType, bytes memory signerSignature, bytes memory ownerApprovalSignature, uint48 approvalValidUntil) =
            _decodeAuthorization(authorization);

        if (signerType == _OWNER_SIGNER) {
            if (SignatureLib.recoverEthSigned(userOpHash, signerSignature) != owner) {
                revert InvalidAuthorization();
            }
            policyEngine.authorizeOwnerUserOp(userOpHash);
            // Root-owner operations have unlimited authority and do not create a spend reservation.
            return 0;
        }
        if (signerType != _AGENT_SIGNER) revert InvalidSignerType(signerType);
        if (agentStatus == AgentStatus.FROZEN) revert AgentKeyFrozen();
        if (SignatureLib.recoverEthSigned(userOpHash, signerSignature) != policyEngine.agentKey()) {
            revert InvalidAuthorization();
        }

        bytes4 selector = _selectorOf(data);
        (uint256 tokenAmount, address recipient) = _tokenAmountAndRecipient(data, selector);
        (uint256 riskScore, bool frozen) = anomalyGuard.observeUserOp(target, selector, recipient, value == 0 ? tokenAmount : value);
        if (frozen || riskScore >= anomalyGuard.freezeThreshold()) return 1;
        uint48 validUntil = policyEngine.validateUserOpPolicy(
            userOpHash,
            target,
            value,
            selector,
            recipient,
            tokenAmount,
            keccak256(data),
            ownerApprovalSignature,
            approvalValidUntil
        );
        return uint256(validUntil) << 160;
    }

    function _decodeAuthorization(bytes calldata authorization)
        internal
        pure
        returns (uint8 signerType, bytes memory signerSignature, bytes memory ownerApprovalSignature, uint48 approvalValidUntil)
    {
        if (authorization.length < 128) revert InvalidAuthorization();
        (signerType, signerSignature, ownerApprovalSignature, approvalValidUntil) =
            abi.decode(authorization, (uint8, bytes, bytes, uint48));
    }

    function _decodeExecution(bytes calldata callData)
        internal
        pure
        returns (bytes32 userOpHash, address target, uint256 value, bytes calldata data)
    {
        bytes4 selector;
        assembly {
            selector := calldataload(callData.offset)
        }
        if (selector != EXECUTE_SELECTOR) revert InvalidExecutionSelector(selector);
        if (callData.length < 4 + 128) revert PolicyViolation_MalformedCalldata();

        uint256 dynamicOffset;
        uint256 dataLength;
        assembly {
            userOpHash := calldataload(add(callData.offset, 4))
            target := shr(96, calldataload(add(callData.offset, 36)))
            value := calldataload(add(callData.offset, 68))
            dynamicOffset := calldataload(add(callData.offset, 100))
        }
        if (dynamicOffset < 128 || dynamicOffset % 32 != 0) revert PolicyViolation_MalformedCalldata();
        uint256 dataLengthWord = 4 + dynamicOffset;
        if (dataLengthWord > callData.length - 32) revert PolicyViolation_MalformedCalldata();
        assembly {
            dataLength := calldataload(add(callData.offset, dataLengthWord))
        }
        uint256 dataStart = dataLengthWord + 32;
        if (dataLength > callData.length - dataStart) revert PolicyViolation_MalformedCalldata();
        data = callData[dataStart:dataStart + dataLength];
    }

    function _selectorOf(bytes calldata data) internal pure returns (bytes4 selector) {
        if (data.length == 0) return bytes4(0);
        if (data.length < 4) revert PolicyViolation_MalformedCalldata();
        assembly {
            selector := calldataload(data.offset)
        }
    }

    function _tokenAmountAndRecipient(bytes calldata data, bytes4 selector)
        internal
        pure
        returns (uint256 amount, address recipient)
    {
        if (selector == bytes4(0)) return (0, address(0));
        if (selector == _ERC20_TRANSFER_SELECTOR || selector == _ERC20_APPROVE_SELECTOR) {
            if (data.length < 4 + 64) revert PolicyViolation_MalformedCalldata();
            recipient = _addressWord(data, 0);
            amount = _uintWord(data, 1);
            return (amount, recipient);
        }
        if (selector == _ERC20_TRANSFER_FROM_SELECTOR) {
            if (data.length < 4 + 96) revert PolicyViolation_MalformedCalldata();
            recipient = _addressWord(data, 1);
            amount = _uintWord(data, 2);
        }
        if (selector == _PAY_CREDITS_SELECTOR) {
            if (data.length < 4 + 64) revert PolicyViolation_MalformedCalldata();
            recipient = _addressWord(data, 0);
            amount = _uintWord(data, 1);
        }
    }

    function _addressWord(bytes calldata data, uint256 argumentIndex) internal pure returns (address value) {
        uint256 word = _uintWord(data, argumentIndex);
        if (word >> 160 != 0) revert PolicyViolation_MalformedCalldata();
        value = address(uint160(word));
    }

    function _uintWord(bytes calldata data, uint256 argumentIndex) internal pure returns (uint256 value) {
        uint256 offset = 4 + argumentIndex * 32;
        if (offset > data.length - 32) revert PolicyViolation_MalformedCalldata();
        assembly {
            value := calldataload(add(data.offset, offset))
        }
    }

    function _unpackNonce(uint256 nonce) internal pure returns (uint192 key, uint64 sequence) {
        key = uint192(nonce >> 64);
        sequence = uint64(nonce);
    }

    function _payPrefund(uint256 missingAccountFunds) internal {
        if (missingAccountFunds == 0) return;
        (bool success,) = payable(msg.sender).call{value: missingAccountFunds}("");
        if (!success) revert PrefundPaymentFailed();
    }

    function _bubbleRevert(bytes memory reason) private pure {
        if (reason.length == 0) revert ExecutionFailed(reason);
        assembly {
            revert(add(reason, 32), mload(reason))
        }
    }
}
