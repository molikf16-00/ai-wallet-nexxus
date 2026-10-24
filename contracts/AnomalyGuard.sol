// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AnomalyGuard
/// @notice Rolling statistical detector for agent UserOperations with automatic freeze callbacks.
contract AnomalyGuard {
    enum AgentStatus {
        ACTIVE,
        FROZEN
    }

    error UnauthorizedAccount(address caller);
    error UnauthorizedOwner(address caller);
    error UnauthorizedSentinel(address caller);
    error AgentKeyFrozen();
    error InvalidAddress();
    error InvalidThreshold(uint256 threshold);
    error InvalidSchedule(uint8 startHour, uint8 endHour);
    error InvalidOwner();

    uint256 public constant SCORE_SCALE = 1e18;
    uint256 public constant DAY = 1 days;
    uint256 public constant SEVEN_DAYS = 7 days;
    uint256 public constant HOUR = 1 hours;

    address public immutable account;
    address public owner;
    address public sentinel;

    AgentStatus public agentStatus;
    uint256 public freezeThreshold;
    uint256 public alphaBps;
    uint256 public baselineTpmScaled;
    uint256 public velocityMultiplierBps;
    uint256 public zScoreThresholdScaled;
    uint8 public expectedStartHourUtc;
    uint8 public expectedEndHourUtc;

    uint256 public ewmaTpmScaled;
    uint256 public lastObservedAt;
    uint256 public historyWindowStart;
    uint256 public historyCount;
    uint256 public historySumWei;
    uint256 public historySumSquares;
    uint256 public entropyWindowStart;
    uint256 public unfamiliarInteractionCount;
    uint256 public unfamiliarRecipientCount;
    uint256 public frozenAt;
    uint256 public lastRiskScore;
    bytes32 public lastFreezeReason;

    mapping(bytes32 interaction => bool knownInteraction) public knownInteractions;
    mapping(address recipient => bool knownRecipient) public knownRecipients;

    event ConfigurationUpdated(uint256 freezeThreshold, uint256 alphaBps, uint256 baselineTpmScaled, uint256 velocityMultiplierBps, uint256 zScoreThresholdScaled, uint8 expectedStartHourUtc, uint8 expectedEndHourUtc);
    event SentinelUpdated(address indexed previousSentinel, address indexed newSentinel);
    event InteractionProfileUpdated(address indexed target, bytes4 indexed selector, bool known);
    event RecipientProfileUpdated(address indexed recipient, bool known);
    event AnomalyObserved(bytes32 indexed interaction, uint256 velocityRisk, uint256 volatilityRisk, uint256 diversityRisk, uint256 timingRisk, uint256 aggregateRisk, bool frozen);
    event AgentFrozen(bytes32 indexed reason, uint256 riskScore, uint256 timestamp);
    event AgentUnfrozen(uint256 timestamp);

    modifier onlyAccount() {
        if (msg.sender != account) revert UnauthorizedAccount(msg.sender);
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner && msg.sender != account) revert UnauthorizedOwner(msg.sender);
        _;
    }

    modifier onlySentinelOrAccount() {
        if (msg.sender != sentinel && msg.sender != account && msg.sender != owner) revert UnauthorizedSentinel(msg.sender);
        _;
    }

    constructor(address account_, address owner_) {
        if (account_ == address(0) || owner_ == address(0)) revert InvalidAddress();
        account = account_;
        owner = owner_;
        agentStatus = AgentStatus.ACTIVE;
        freezeThreshold = 75;
        alphaBps = 2_500;
        baselineTpmScaled = SCORE_SCALE;
        velocityMultiplierBps = 40_000;
        zScoreThresholdScaled = 3 * SCORE_SCALE;
        expectedStartHourUtc = 0;
        expectedEndHourUtc = 24;
        historyWindowStart = block.timestamp;
        entropyWindowStart = block.timestamp;
    }

    /// @notice Updates the detector sensitivity and expected operating schedule.
    function setConfiguration(
        uint256 freezeThreshold_,
        uint256 alphaBps_,
        uint256 baselineTpmScaled_,
        uint256 velocityMultiplierBps_,
        uint256 zScoreThresholdScaled_,
        uint8 expectedStartHourUtc_,
        uint8 expectedEndHourUtc_
    ) external onlyOwner {
        if (freezeThreshold_ == 0 || freezeThreshold_ > 100) revert InvalidThreshold(freezeThreshold_);
        if (alphaBps_ == 0 || alphaBps_ > 10_000 || baselineTpmScaled_ == 0 || velocityMultiplierBps_ == 0 || zScoreThresholdScaled_ == 0) revert InvalidThreshold(freezeThreshold_);
        if (expectedStartHourUtc_ > 24 || expectedEndHourUtc_ > 24) revert InvalidSchedule(expectedStartHourUtc_, expectedEndHourUtc_);
        freezeThreshold = freezeThreshold_;
        alphaBps = alphaBps_;
        baselineTpmScaled = baselineTpmScaled_;
        velocityMultiplierBps = velocityMultiplierBps_;
        zScoreThresholdScaled = zScoreThresholdScaled_;
        expectedStartHourUtc = expectedStartHourUtc_;
        expectedEndHourUtc = expectedEndHourUtc_;
        emit ConfigurationUpdated(freezeThreshold_, alphaBps_, baselineTpmScaled_, velocityMultiplierBps_, zScoreThresholdScaled_, expectedStartHourUtc_, expectedEndHourUtc_);
    }

    /// @notice Authorizes a low-latency sentinel watcher.
    function setSentinel(address newSentinel) external onlyOwner {
        emit SentinelUpdated(sentinel, newSentinel);
        sentinel = newSentinel;
    }

    /// @notice Synchronizes the wallet owner after social recovery or administrative transfer.
    function setOwner(address newOwner) external onlyAccount {
        if (newOwner == address(0)) revert InvalidOwner();
        owner = newOwner;
    }

    /// @notice Marks a target-selector pair as part of the normal interaction profile.
    function setKnownInteraction(address target, bytes4 selector, bool known) external onlyOwner {
        knownInteractions[keccak256(abi.encodePacked(target, selector))] = known;
        emit InteractionProfileUpdated(target, selector, known);
    }

    /// @notice Marks a recipient as part of the normal recipient profile.
    function setKnownRecipient(address recipient, bool known) external onlyOwner {
        knownRecipients[recipient] = known;
        emit RecipientProfileUpdated(recipient, known);
    }

    /// @notice Records a candidate transaction and freezes the account when risk crosses the threshold.
    function observeUserOp(address target, bytes4 selector, address recipient, uint256 amountWei) external onlySentinelOrAccount returns (uint256 riskScore, bool frozen) {
        if (agentStatus == AgentStatus.FROZEN) revert AgentKeyFrozen();
        _refreshWindows();
        uint256 velocityRisk = _velocityRisk();
        uint256 volatilityRisk = _volatilityRisk(amountWei);
        uint256 diversityRisk = _diversityRisk(target, selector, recipient);
        uint256 timingRisk = _timingRisk();
        riskScore = velocityRisk + volatilityRisk + diversityRisk + timingRisk;
        if (riskScore > 100) riskScore = 100;
        lastRiskScore = riskScore;
        bytes32 interaction = keccak256(abi.encodePacked(target, selector));
        if (riskScore >= freezeThreshold) {
            _freeze(keccak256(abi.encode(interaction, riskScore, block.timestamp)));
            frozen = true;
        }
        emit AnomalyObserved(interaction, velocityRisk, volatilityRisk, diversityRisk, timingRisk, riskScore, frozen);
        _updateHistory(amountWei);
        _updateVelocity();
    }

    /// @notice Freezes the agent from the account owner or authorized sentinel.
    function freeze(bytes32 reason) external onlySentinelOrAccount {
        _freeze(reason);
    }

    /// @notice Unfreezes the agent after owner review.
    function unfreeze() external onlyOwner {
        agentStatus = AgentStatus.ACTIVE;
        frozenAt = 0;
        lastFreezeReason = bytes32(0);
        emit AgentUnfrozen(block.timestamp);
    }

    function _freeze(bytes32 reason) internal {
        if (agentStatus == AgentStatus.FROZEN) return;
        agentStatus = AgentStatus.FROZEN;
        frozenAt = block.timestamp;
        lastFreezeReason = reason;
        IAnomalyFreezeCallback(account).freezeFromAnomalyGuard();
        emit AgentFrozen(reason, lastRiskScore, block.timestamp);
    }

    function _refreshWindows() internal {
        if (block.timestamp >= historyWindowStart + SEVEN_DAYS) {
            historyWindowStart = block.timestamp;
            historyCount = 0;
            historySumWei = 0;
            historySumSquares = 0;
        }
        if (block.timestamp >= entropyWindowStart + HOUR) {
            entropyWindowStart = block.timestamp;
            unfamiliarInteractionCount = 0;
            unfamiliarRecipientCount = 0;
        }
    }

    function _velocityRisk() internal view returns (uint256) {
        if (lastObservedAt == 0) return 0;
        uint256 delta = block.timestamp > lastObservedAt ? block.timestamp - lastObservedAt : 1;
        uint256 instantaneousTpm = (60 * SCORE_SCALE) / delta;
        uint256 ewma = ewmaTpmScaled == 0 ? instantaneousTpm : (alphaBps * instantaneousTpm + (10_000 - alphaBps) * ewmaTpmScaled) / 10_000;
        if (ewma * 10_000 <= baselineTpmScaled * velocityMultiplierBps) return 0;
        uint256 excessBps = (ewma * 10_000) / (baselineTpmScaled * velocityMultiplierBps);
        if (excessBps >= 8_000) return 35;
        if (excessBps >= 6_000) return 28;
        return 20;
    }

    function _volatilityRisk(uint256 amountWei) internal view returns (uint256) {
        if (historyCount < 3) return 0;
        uint256 mean = historySumWei / historyCount;
        if (amountWei == mean) return 0;
        if (historySumSquares <= historySumWei * mean) return amountWei > mean ? 30 : 10;
        uint256 variance = (historySumSquares - historySumWei * mean) / historyCount;
        if (variance == 0) return amountWei > mean ? 30 : 10;
        uint256 difference = amountWei > mean ? amountWei - mean : mean - amountWei;
        uint256 zSquared = (difference * difference * SCORE_SCALE) / variance;
        uint256 thresholdSquared = (zScoreThresholdScaled * zScoreThresholdScaled) / SCORE_SCALE;
        if (zSquared >= thresholdSquared * 4) return 30;
        if (zSquared >= thresholdSquared) return 20;
        return 8;
    }

    function _diversityRisk(address target, bytes4 selector, address recipient) internal returns (uint256) {
        uint256 score;
        bytes32 interaction = keccak256(abi.encodePacked(target, selector));
        if (!knownInteractions[interaction]) unfamiliarInteractionCount += 1;
        if (recipient != address(0) && !knownRecipients[recipient]) unfamiliarRecipientCount += 1;
        uint256 unfamiliar = unfamiliarInteractionCount + unfamiliarRecipientCount;
        if (unfamiliar >= 4) score = 30;
        else if (unfamiliar >= 2) score = 22;
        else if (unfamiliar == 1) score = 10;
        return score;
    }

    function _timingRisk() internal view returns (uint256) {
        uint256 hour = (block.timestamp % DAY) / HOUR;
        bool expected;
        if (expectedStartHourUtc == expectedEndHourUtc) expected = true;
        else if (expectedStartHourUtc < expectedEndHourUtc) expected = hour >= expectedStartHourUtc && hour < expectedEndHourUtc;
        else expected = hour >= expectedStartHourUtc || hour < expectedEndHourUtc;
        return expected ? 0 : 15;
    }

    function _updateHistory(uint256 amountWei) internal {
        historyCount += 1;
        historySumWei += amountWei;
        if (amountWei <= type(uint128).max) historySumSquares += amountWei * amountWei;
        else historySumSquares = type(uint256).max;
    }

    function _updateVelocity() internal {
        uint256 delta = lastObservedAt == 0 || block.timestamp <= lastObservedAt ? 1 : block.timestamp - lastObservedAt;
        uint256 instantaneousTpm = (60 * SCORE_SCALE) / delta;
        ewmaTpmScaled = ewmaTpmScaled == 0 ? instantaneousTpm : (alphaBps * instantaneousTpm + (10_000 - alphaBps) * ewmaTpmScaled) / 10_000;
        lastObservedAt = block.timestamp;
    }
}

interface IAnomalyFreezeCallback {
    function freezeFromAnomalyGuard() external;
}
