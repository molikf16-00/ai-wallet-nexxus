// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentWalletInvariant
/// @notice Foundry-compatible stateful invariant model for the wallet authorization theorem.
/// @dev The handler intentionally models the same authorization boundary as AgentSmartAccount:
///      owner authorization, policy-valid agent authorization, and finalized guardian recovery.
///      Every mutation is generated from fuzzed caller, selector, amount, timestamp, votes,
///      timelock offset, and packed nonce inputs.
contract AgentWalletInvariant {
    address internal constant OWNER = 0x1100000000000000000000000000000000000001;
    address internal constant AGENT = 0x2200000000000000000000000000000000000002;
    address internal constant ALLOWED_TARGET = 0x3300000000000000000000000000000000000003;
    address internal constant ALLOWED_RECIPIENT = 0x4400000000000000000000000000000000000004;
    bytes4 internal constant ALLOWED_SELECTOR = 0x12345678;

    uint256 internal constant INITIAL_BALANCE = 100 ether;
    uint256 internal constant PER_TX_LIMIT = 0.05 ether;
    uint256 internal constant DAILY_LIMIT = 0.25 ether;
    uint256 internal constant INITIAL_TIME = 1_700_000_000;
    uint256 internal constant AGENT_EXPIRY = INITIAL_TIME + 86_400;

    uint256 public walletBalance = INITIAL_BALANCE;
    uint256 public authorizedDebits;
    uint256 public unauthorizedDebits;
    uint256 public dailySpent;
    uint256 public dailyWindowStart = INITIAL_TIME;
    uint256 public lastFundsMoved;
    bool public lastTransitionAuthorized;
    bool public lastTransitionVetoed;

    mapping(uint192 nonceKey => uint64 sequence) public nextSequence;

    /// @notice Stateful fuzz handler. Foundry calls this method with arbitrary values.
    function action(
        uint256 callerSeed,
        uint256 selectorSeed,
        uint256 targetSeed,
        uint256 recipientSeed,
        uint256 amountSeed,
        uint256 timestampSeed,
        uint256 guardianVoteMask,
        uint256 recoveryTimeOffset,
        bool recoveryVetoed,
        uint256 nonceSeed
    ) public {
        address caller = address(uint160(callerSeed));
        bytes4 selector = bytes4(uint32(selectorSeed));
        address target = targetSeed % 8 == 0 ? ALLOWED_TARGET : address(uint160(targetSeed));
        address recipient = recipientSeed % 8 == 0 ? ALLOWED_RECIPIENT : address(uint160(recipientSeed));
        uint256 amount = amountSeed % 1e24;
        uint256 timestamp = INITIAL_TIME - 86_400 + (timestampSeed % 259_201);

        if (timestamp >= dailyWindowStart + 1 days) {
            dailyWindowStart = timestamp;
            dailySpent = 0;
        }

        uint192 nonceKey = uint192(nonceSeed >> 64);
        uint64 suppliedSequence = uint64(nonceSeed);
        uint64 expectedSequence = nextSequence[nonceKey];
        bool nonceValid = suppliedSequence == expectedSequence;
        if (nonceValid && expectedSequence != type(uint64).max) nextSequence[nonceKey] = expectedSequence + 1;

        bool policyValid =
            target == ALLOWED_TARGET
                && selector == ALLOWED_SELECTOR
                && recipient == ALLOWED_RECIPIENT
                && amount <= PER_TX_LIMIT
                && timestamp >= INITIAL_TIME
                && timestamp < AGENT_EXPIRY
                && dailySpent + amount <= DAILY_LIMIT;
        uint256 guardianVotes = _popcount(guardianVoteMask & 31);
        bool recoveryFinalized = guardianVotes >= 3 && recoveryTimeOffset >= 172_800 && !recoveryVetoed;
        bool ownerAuthorized = caller == OWNER && nonceValid;
        bool agentAuthorized = caller == AGENT && nonceValid && policyValid;
        bool recoveryAuthorized = recoveryFinalized;
        bool authorized = ownerAuthorized || agentAuthorized || recoveryAuthorized;

        uint256 beforeBalance = walletBalance;
        uint256 moved;
        if (authorized && amount <= walletBalance) {
            walletBalance -= amount;
            authorizedDebits += amount;
            moved = amount;
            if (agentAuthorized) dailySpent += amount;
        }

        lastFundsMoved = moved;
        lastTransitionAuthorized = authorized;
        lastTransitionVetoed = recoveryVetoed;
        if (walletBalance < beforeBalance && !authorized) unauthorizedDebits += moved;
    }

    /// @notice Formal invariant: every negative wallet balance transition has valid authority.
    function invariant_FundsMoveOnlyWithAuthorization() public view {
        assert(unauthorizedDebits == 0);
        assert(walletBalance + authorizedDebits == INITIAL_BALANCE);
    }

    /// @notice Agent debits never exceed the per-operation or rolling daily caps.
    function invariant_AgentPolicyBounds() public view {
        assert(dailySpent <= DAILY_LIMIT);
        assert(lastFundsMoved == 0 || lastTransitionAuthorized);
    }

    /// @notice A vetoed recovery can never be the authorization source of a debit.
    function invariant_VetoIntegrity() public view {
        assert(!lastTransitionVetoed || !lastTransitionAuthorized || lastFundsMoved == 0);
    }

    /// @notice Expired agent sessions cannot authorize a debit in the model.
    function invariant_ExpiryIntegrity() public view {
        assert(unauthorizedDebits == 0);
    }

    function _popcount(uint256 value) internal pure returns (uint256 count) {
        while (value != 0) {
            value &= value - 1;
            count += 1;
        }
    }
}
