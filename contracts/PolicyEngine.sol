// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SignatureLib} from "./libraries/SignatureLib.sol";

/// @title PolicyEngine
/// @notice On-chain, byte-level authorization policy for an AgentWallet session key.
/// @dev The wallet account is the only address allowed to mutate or consume policy state.
///      ERC-20 amounts are tracked per token address because token units are not
///      comparable to native wei without an oracle. The configured numeric limits are
///      therefore applied independently to native wei and each token's smallest unit.
contract PolicyEngine {
    using SignatureLib for bytes32;

    error UnauthorizedAccount(address caller);
    error InvalidAddress();
    error PolicyViolation_ExpiredKey(uint48 validUntil, uint256 timestamp);
    error PolicyViolation_TargetNotAllowed(address target);
    error PolicyViolation_SelectorNotAllowed(address target, bytes4 selector);
    error PolicyViolation_RecipientNotAllowed(address recipient);
    error PolicyViolation_PerTxLimitExceeded(uint256 value, uint256 maximum);
    error PolicyViolation_DailyLimitExceeded(uint256 projected, uint256 limit);
    error PolicyViolation_MalformedCalldata();
    error PolicyViolation_MixedValueTransfer();
    error OwnerApprovalRequired(bytes32 userOpHash, uint256 value);
    error InvalidOwnerApproval(address recovered, address expected);
    error OwnerApprovalExpired(uint48 validUntil, uint256 timestamp);
    error ApprovalDeadlineAfterAgentExpiry(uint48 approvalValidUntil, uint48 agentValidUntil);
    error PendingApprovalAlreadyExists(bytes32 userOpHash);
    error PendingApprovalNotFound(bytes32 userOpHash);
    error PendingApprovalConsumed(bytes32 userOpHash);
    error PendingApprovalMismatch();
    error InvalidAgentKey();
    error InvalidAgentExpiry();

    /// @notice A policy approval reservation created during UserOperation validation.
    struct PendingApproval {
        address target;
        bytes4 selector;
        bytes32 callDataHash;
        uint256 amount;
        uint48 agentValidUntil;
        bool tokenOperation;
        bool ownerApprovalRequired;
        bool consumed;
    }

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant OWNER_APPROVAL_TYPEHASH = keccak256(
        "OwnerApproval(bytes32 userOpHash,address target,uint256 nativeValue,uint256 tokenAmount,bytes32 callDataHash,uint48 validUntil)"
    );

    uint256 public constant WINDOW_SIZE = 24 hours;

    address public immutable account;
    address public owner;

    address public agentKey;
    uint48 public agentValidUntil;
    bool public agentRevoked;

    uint256 public maxPerTxValueWei;
    uint256 public dailyLimitWei;
    uint256 public spentTodayWei;
    uint256 public reservedTodayWei;
    uint256 public windowStartTimestamp;

    bool public requiresOwnerApproval;
    uint256 public ownerApprovalThresholdWei;

    mapping(address target => bool allowed) public allowedTargets;
    mapping(address target => mapping(bytes4 selector => bool allowed)) public allowedSelectors;
    mapping(address target => bytes4[]) private _selectorLists;
    address[] private _allowedTargetList;
    mapping(address target => uint256 indexPlusOne) private _allowedTargetIndex;
    mapping(address recipient => bool allowed) public allowedRecipients;

    mapping(address token => uint256 spent) public spentTodayTokenUnits;
    mapping(address token => uint256 reserved) public reservedTodayTokenUnits;
    mapping(address token => uint256 windowStart) private _tokenWindowStart;
    mapping(bytes32 userOpHash => PendingApproval) public pendingApprovals;
    mapping(bytes32 userOpHash => bool) public ownerAuthorizedUserOps;

    event OwnerUpdated(address indexed previousOwner, address indexed newOwner);
    event AgentKeyUpdated(address indexed previousAgentKey, address indexed newAgentKey, uint48 validUntil);
    event AgentKeyRevoked(address indexed revokedAgentKey);
    event TargetPolicyUpdated(address indexed target, bool allowed);
    event SelectorPolicyUpdated(address indexed target, bytes4 indexed selector, bool allowed);
    event RecipientPolicyUpdated(address indexed recipient, bool allowed);
    event LimitsUpdated(uint256 maxPerTxValueWei, uint256 dailyLimitWei);
    event OwnerApprovalPolicyUpdated(bool required, uint256 threshold);
    event PendingApprovalCreated(bytes32 indexed userOpHash, uint256 amount, bool ownerApprovalRequired);
    event PendingApprovalSettled(bytes32 indexed userOpHash, uint256 amount, bool tokenOperation);

    modifier onlyAccount() {
        if (msg.sender != account) revert UnauthorizedAccount(msg.sender);
        _;
    }

    /// @param account_ The smart account that owns and consumes this policy.
    /// @param owner_ The root EOA authorized to change the policy and sign escalations.
    constructor(address account_, address owner_) {
        if (account_ == address(0) || owner_ == address(0)) revert InvalidAddress();
        account = account_;
        owner = owner_;
        windowStartTimestamp = block.timestamp;
    }

    /// @notice Sets the root owner used for EIP-712 approval signatures.
    function setOwner(address newOwner) external onlyAccount {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Installs a session key and a strict expiry timestamp.
    /// @dev An agent signature is invalid when `block.timestamp >= validUntil`.
    function setAgentKey(address newAgentKey, uint48 validUntil) external onlyAccount {
        if (newAgentKey == address(0)) revert InvalidAgentKey();
        if (validUntil <= block.timestamp) revert InvalidAgentExpiry();
        emit AgentKeyUpdated(agentKey, newAgentKey, validUntil);
        agentKey = newAgentKey;
        agentValidUntil = validUntil;
        agentRevoked = false;
    }

    /// @notice Revokes the current session key immediately.
    function revokeAgentKey() external onlyAccount {
        agentRevoked = true;
        emit AgentKeyRevoked(agentKey);
    }

    /// @notice Configures native/token numeric caps. A zero cap means unlimited.
    function setLimits(uint256 newMaxPerTxValueWei, uint256 newDailyLimitWei) external onlyAccount {
        maxPerTxValueWei = newMaxPerTxValueWei;
        dailyLimitWei = newDailyLimitWei;
        emit LimitsUpdated(newMaxPerTxValueWei, newDailyLimitWei);
    }

    /// @notice Configures whether an owner EIP-712 approval is needed above a threshold.
    /// @dev A zero threshold requires approval for every non-zero operation.
    function setOwnerApprovalPolicy(bool required, uint256 threshold) external onlyAccount {
        requiresOwnerApproval = required;
        ownerApprovalThresholdWei = threshold;
        emit OwnerApprovalPolicyUpdated(required, threshold);
    }

    /// @notice Adds or removes a contract target from the session-key allowlist.
    function setAllowedTarget(address target, bool allowed) external onlyAccount {
        if (target == address(0)) revert InvalidAddress();
        if (allowed && !allowedTargets[target]) {
            _allowedTargetList.push(target);
            _allowedTargetIndex[target] = _allowedTargetList.length;
        } else if (!allowed && allowedTargets[target]) {
            uint256 index = _allowedTargetIndex[target] - 1;
            uint256 lastIndex = _allowedTargetList.length - 1;
            if (index != lastIndex) {
                address lastTarget = _allowedTargetList[lastIndex];
                _allowedTargetList[index] = lastTarget;
                _allowedTargetIndex[lastTarget] = index + 1;
            }
            _allowedTargetList.pop();
            delete _allowedTargetIndex[target];
        }
        allowedTargets[target] = allowed;
        emit TargetPolicyUpdated(target, allowed);
    }

    /// @notice Adds or removes a 4-byte selector for an allowed target.
    function setAllowedSelector(address target, bytes4 selector, bool allowed) external onlyAccount {
        if (target == address(0)) revert InvalidAddress();
        if (allowed && !allowedSelectors[target][selector]) {
            _selectorLists[target].push(selector);
        }
        allowedSelectors[target][selector] = allowed;
        emit SelectorPolicyUpdated(target, selector, allowed);
    }

    /// @notice Adds or removes a direct-transfer recipient from the allowlist.
    function setAllowedRecipient(address recipient, bool allowed) external onlyAccount {
        if (recipient == address(0)) revert InvalidAddress();
        allowedRecipients[recipient] = allowed;
        emit RecipientPolicyUpdated(recipient, allowed);
    }

    /// @notice Returns the current target allowlist.
    function getAllowedTargets() external view returns (address[] memory) {
        return _allowedTargetList;
    }

    /// @notice Returns every selector ever configured for a target, including disabled entries.
    /// @dev The boolean mapping is authoritative; retaining the compact list avoids an
    ///      expensive array deletion and makes policy inspection deterministic.
    function getAllowedSelectors(address target) external view returns (bytes4[] memory) {
        return _selectorLists[target];
    }

    /// @notice Returns the EIP-712 domain separator used for owner approvals.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("AgentWallet Policy")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Hashes the exact owner approval payload required by policy escalation.
    function ownerApprovalDigest(
        bytes32 userOpHash,
        address target,
        uint256 nativeValue,
        uint256 tokenAmount,
        bytes32 callDataHash,
        uint48 validUntil
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(OWNER_APPROVAL_TYPEHASH, userOpHash, target, nativeValue, tokenAmount, callDataHash, validUntil)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Validates and reserves one agent UserOperation.
    /// @dev This function deliberately records a pending reservation during real EntryPoint
    ///      execution. Failed handleOps transactions revert the reservation atomically.
    function validateUserOpPolicy(
        bytes32 userOpHash,
        address target,
        uint256 nativeValue,
        bytes4 selector,
        address recipient,
        uint256 tokenAmount,
        bytes32 callDataHash,
        bytes calldata ownerApprovalSignature,
        uint48 ownerApprovalValidUntil
    ) external onlyAccount returns (uint48 validUntil) {
        _refreshWindow();
        if (agentRevoked || agentKey == address(0) || block.timestamp >= agentValidUntil) {
            revert PolicyViolation_ExpiredKey(agentValidUntil, block.timestamp);
        }
        if (nativeValue != 0 && tokenAmount != 0) revert PolicyViolation_MixedValueTransfer();

        bool tokenOperation = tokenAmount != 0;
        uint256 amount = tokenOperation ? tokenAmount : nativeValue;
        if (maxPerTxValueWei != 0 && amount > maxPerTxValueWei) {
            revert PolicyViolation_PerTxLimitExceeded(amount, maxPerTxValueWei);
        }

        if (recipient != address(0) && !allowedRecipients[recipient]) {
            revert PolicyViolation_RecipientNotAllowed(recipient);
        }

        if (nativeValue != 0 && selector == bytes4(0)) {
            if (!allowedRecipients[target]) revert PolicyViolation_RecipientNotAllowed(target);
        } else {
            if (!allowedTargets[target]) revert PolicyViolation_TargetNotAllowed(target);
            if (!allowedSelectors[target][selector]) {
                revert PolicyViolation_SelectorNotAllowed(target, selector);
            }
        }

        uint256 spent;
        uint256 reserved;
        if (tokenOperation) {
            if (_tokenWindowStart[target] != windowStartTimestamp) {
                _tokenWindowStart[target] = windowStartTimestamp;
                spentTodayTokenUnits[target] = 0;
                reservedTodayTokenUnits[target] = 0;
            }
            spent = spentTodayTokenUnits[target];
            reserved = reservedTodayTokenUnits[target];
        } else {
            spent = spentTodayWei;
            reserved = reservedTodayWei;
        }
        bool exceedsDaily = dailyLimitWei != 0 && spent + reserved + amount > dailyLimitWei;
        bool thresholdApproval = requiresOwnerApproval && amount > ownerApprovalThresholdWei;
        bool approvalRequired = thresholdApproval || exceedsDaily;

        if (exceedsDaily && !requiresOwnerApproval) {
            revert PolicyViolation_DailyLimitExceeded(spent + reserved + amount, dailyLimitWei);
        }
        if (approvalRequired) {
            if (ownerApprovalSignature.length == 0) revert OwnerApprovalRequired(userOpHash, amount);
            if (ownerApprovalValidUntil == 0 || block.timestamp >= ownerApprovalValidUntil) {
                revert OwnerApprovalExpired(ownerApprovalValidUntil, block.timestamp);
            }
            if (ownerApprovalValidUntil > agentValidUntil) {
                revert ApprovalDeadlineAfterAgentExpiry(ownerApprovalValidUntil, agentValidUntil);
            }
            address recovered = SignatureLib.recover(
                ownerApprovalDigest(
                    userOpHash,
                    target,
                    nativeValue,
                    tokenAmount,
                    callDataHash,
                    ownerApprovalValidUntil
                ),
                ownerApprovalSignature
            );
            if (recovered != owner) revert InvalidOwnerApproval(recovered, owner);
        }

        PendingApproval storage pending = pendingApprovals[userOpHash];
        if (pending.target != address(0)) revert PendingApprovalAlreadyExists(userOpHash);
        pending.target = target;
        pending.selector = selector;
        pending.callDataHash = callDataHash;
        pending.amount = amount;
        pending.agentValidUntil = agentValidUntil;
        pending.tokenOperation = tokenOperation;
        pending.ownerApprovalRequired = approvalRequired;
        pending.consumed = false;

        if (tokenOperation) {
            reservedTodayTokenUnits[target] += amount;
        } else {
            reservedTodayWei += amount;
        }
        emit PendingApprovalCreated(userOpHash, amount, approvalRequired);
        return agentValidUntil;
    }

    /// @notice Records a root-owner UserOperation so its EntryPoint execution can bypass
    ///         the agent reservation path while remaining bound to the validated hash.
    function authorizeOwnerUserOp(bytes32 userOpHash) external onlyAccount {
        ownerAuthorizedUserOps[userOpHash] = true;
    }

    /// @notice Consumes a root-owner UserOperation authorization at execution time.
    function consumeOwnerUserOp(bytes32 userOpHash) external onlyAccount {
        if (!ownerAuthorizedUserOps[userOpHash]) revert PendingApprovalNotFound(userOpHash);
        delete ownerAuthorizedUserOps[userOpHash];
    }

    /// @notice Decodes an ERC-20 transfer-like payload for callers that want to
    ///         perform the byte-level policy check inside this engine.
    /// @dev This helper recognizes transfer, approve, and transferFrom ABI layouts.
    function decodeTokenCall(bytes calldata data)
        external
        pure
        returns (bytes4 selector, address recipient, uint256 amount)
    {
        if (data.length < 4) revert PolicyViolation_MalformedCalldata();
        assembly {
            selector := calldataload(data.offset)
        }
        if (selector == bytes4(keccak256("transfer(address,uint256)")) || selector == bytes4(keccak256("approve(address,uint256)"))) {
            if (data.length < 68) revert PolicyViolation_MalformedCalldata();
            assembly {
                recipient := shr(96, calldataload(add(data.offset, 4)))
                amount := calldataload(add(data.offset, 36))
            }
            return (selector, recipient, amount);
        }
        if (selector == bytes4(keccak256("transferFrom(address,address,uint256)"))) {
            if (data.length < 100) revert PolicyViolation_MalformedCalldata();
            assembly {
                recipient := shr(96, calldataload(add(data.offset, 36)))
                amount := calldataload(add(data.offset, 68))
            }
            return (selector, recipient, amount);
        }
        return (selector, address(0), 0);
    }

    /// @notice Consumes a reservation immediately before the account performs the call.
    function consumePendingApproval(
        bytes32 userOpHash,
        address target,
        bytes4 selector,
        uint256 nativeValue,
        uint256 tokenAmount,
        bytes32 callDataHash
    ) external onlyAccount {
        _refreshWindow();
        PendingApproval storage pending = pendingApprovals[userOpHash];
        if (pending.target == address(0)) revert PendingApprovalNotFound(userOpHash);
        if (pending.consumed) revert PendingApprovalConsumed(userOpHash);
        if (
            pending.target != target || pending.selector != selector || pending.callDataHash != callDataHash
                || pending.amount != (tokenAmount != 0 ? tokenAmount : nativeValue)
                || pending.tokenOperation != (tokenAmount != 0)
        ) revert PendingApprovalMismatch();

        pending.consumed = true;
        if (pending.tokenOperation) {
            if (_tokenWindowStart[target] != windowStartTimestamp) {
                _tokenWindowStart[target] = windowStartTimestamp;
                spentTodayTokenUnits[target] = 0;
                reservedTodayTokenUnits[target] = 0;
            }
            reservedTodayTokenUnits[target] -= pending.amount;
            spentTodayTokenUnits[target] += pending.amount;
        } else {
            reservedTodayWei -= pending.amount;
            spentTodayWei += pending.amount;
        }
        emit PendingApprovalSettled(userOpHash, pending.amount, pending.tokenOperation);
    }

    /// @notice Returns the current native spend including reservations in this window.
    function currentNativeSpend() external view returns (uint256) {
        if (block.timestamp >= windowStartTimestamp + WINDOW_SIZE) return 0;
        return spentTodayWei + reservedTodayWei;
    }

    /// @notice Returns the current token spend including reservations in this window.
    function currentTokenSpend(address token) external view returns (uint256) {
        if (block.timestamp >= windowStartTimestamp + WINDOW_SIZE) return 0;
        if (_tokenWindowStart[token] != windowStartTimestamp) return 0;
        return spentTodayTokenUnits[token] + reservedTodayTokenUnits[token];
    }

    function _refreshWindow() internal {
        if (block.timestamp >= windowStartTimestamp + WINDOW_SIZE) {
            windowStartTimestamp = block.timestamp;
            spentTodayWei = 0;
            reservedTodayWei = 0;
            // Token maps are intentionally not iterated here. A token's stale values are
            // ignored after the window boundary and replaced lazily on its next operation.
        }
    }
}
