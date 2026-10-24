// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GuardianRecoveryModule
/// @notice 3-of-5 guardian social recovery with a 48-hour execution delay and owner veto.
/// @dev The smart account remains the sole authority that can configure this module or
///      accept its final recovery callback. Guardian approvals are counted by address,
///      so duplicate signatures cannot satisfy quorum.
contract GuardianRecoveryModule {
    uint256 public constant GUARDIAN_COUNT = 5;
    uint256 public constant QUORUM = 3;
    uint256 public constant RECOVERY_DELAY = 48 hours;

    enum RecoveryTarget {
        OWNER,
        AGENT
    }

    enum ProposalStatus {
        NONE,
        ACTIVE,
        PENDING,
        EXECUTED,
        VETOED
    }

    struct RecoveryProposal {
        uint256 id;
        address proposer;
        address newKey;
        RecoveryTarget target;
        ProposalStatus status;
        uint8 approvalCount;
        uint48 createdAt;
        uint48 executableAfter;
        uint48 executedAt;
        uint48 vetoedAt;
    }

    error UnauthorizedWallet(address caller);
    error UnauthorizedGuardian(address caller);
    error UnauthorizedOwner(address caller);
    error InvalidAddress();
    error DuplicateGuardian(address guardian);
    error GuardianSetAlreadyConfigured();
    error InvalidRecoveryId(uint256 recoveryId);
    error InvalidNewKey();
    error InvalidProposalStatus(ProposalStatus status);
    error GuardianAlreadyApproved(uint256 recoveryId, address guardian);
    error QuorumNotReached(uint256 recoveryId, uint256 approvals);
    error RecoveryTimelockActive(uint256 recoveryId, uint48 executableAfter, uint256 timestamp);
    error RecoveryExecutionFailed();

    address public immutable wallet;
    address public owner;
    bool public guardiansConfigured;
    uint256 public nextRecoveryId = 1;

    address[GUARDIAN_COUNT] private _guardians;
    mapping(address guardian => bool) public isGuardian;
    mapping(uint256 recoveryId => RecoveryProposal) public proposals;
    mapping(uint256 recoveryId => mapping(address guardian => bool)) public hasApproved;

    event GuardiansConfigured(address[GUARDIAN_COUNT] guardians);
    event OwnerSynchronized(address indexed previousOwner, address indexed newOwner);
    event RecoveryInitiated(uint256 indexed recoveryId, address indexed proposer, address indexed newKey, RecoveryTarget target);
    event GuardianApprovalAdded(uint256 indexed recoveryId, address indexed guardian, uint8 approvalCount);
    event RecoveryQueued(uint256 indexed recoveryId, uint48 executableAfter);
    event RecoveryVetoed(uint256 indexed recoveryId, address indexed owner, uint48 timestamp);
    event RecoveryExecuted(uint256 indexed recoveryId, address indexed newKey, RecoveryTarget target, uint48 timestamp);

    modifier onlyWallet() {
        if (msg.sender != wallet) revert UnauthorizedWallet(msg.sender);
        _;
    }

    modifier onlyGuardian() {
        if (!isGuardian[msg.sender]) revert UnauthorizedGuardian(msg.sender);
        _;
    }

    constructor(address wallet_, address owner_) {
        if (wallet_ == address(0) || owner_ == address(0)) revert InvalidAddress();
        wallet = wallet_;
        owner = owner_;
    }

    /// @notice Registers the complete trusted guardian set exactly once.
    function configureGuardians(address[GUARDIAN_COUNT] calldata guardians) external onlyWallet {
        if (guardiansConfigured) revert GuardianSetAlreadyConfigured();
        for (uint256 index = 0; index < GUARDIAN_COUNT; index++) {
            address guardian = guardians[index];
            if (guardian == address(0)) revert InvalidAddress();
            for (uint256 previous = 0; previous < index; previous++) {
                if (guardians[previous] == guardian) revert DuplicateGuardian(guardian);
            }
            _guardians[index] = guardian;
            isGuardian[guardian] = true;
        }
        guardiansConfigured = true;
        emit GuardiansConfigured(guardians);
    }

    /// @notice Synchronizes the veto authority after the wallet owner changes.
    function synchronizeOwner(address newOwner) external onlyWallet {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnerSynchronized(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Returns the five configured guardians in deterministic order.
    function getGuardians() external view returns (address[GUARDIAN_COUNT] memory) {
        return _guardians;
    }

    /// @notice Creates a recovery proposal. Any one registered guardian may initiate it.
    function initiateRecovery(address newKey, RecoveryTarget target) external onlyGuardian returns (uint256 recoveryId) {
        if (!guardiansConfigured) revert InvalidProposalStatus(ProposalStatus.NONE);
        if (newKey == address(0)) revert InvalidNewKey();
        recoveryId = nextRecoveryId++;
        proposals[recoveryId] = RecoveryProposal({
            id: recoveryId,
            proposer: msg.sender,
            newKey: newKey,
            target: target,
            status: ProposalStatus.ACTIVE,
            approvalCount: 0,
            createdAt: uint48(block.timestamp),
            executableAfter: 0,
            executedAt: 0,
            vetoedAt: 0
        });
        emit RecoveryInitiated(recoveryId, msg.sender, newKey, target);
    }

    /// @notice Adds one distinct guardian approval and starts the 48-hour delay at quorum.
    function approveRecovery(uint256 recoveryId) external onlyGuardian {
        RecoveryProposal storage proposal = _proposal(recoveryId);
        if (proposal.status != ProposalStatus.ACTIVE) revert InvalidProposalStatus(proposal.status);
        if (hasApproved[recoveryId][msg.sender]) revert GuardianAlreadyApproved(recoveryId, msg.sender);
        hasApproved[recoveryId][msg.sender] = true;
        proposal.approvalCount += 1;
        emit GuardianApprovalAdded(recoveryId, msg.sender, proposal.approvalCount);
        if (proposal.approvalCount >= QUORUM) {
            proposal.status = ProposalStatus.PENDING;
            proposal.executableAfter = uint48(block.timestamp + RECOVERY_DELAY);
            emit RecoveryQueued(recoveryId, proposal.executableAfter);
        }
    }

    /// @notice Lets the legitimate owner cancel an active or queued recovery immediately.
    /// @dev All guardian approval bits are cleared so the vetoed proposal cannot be resumed.
    function vetoRecovery(uint256 recoveryId) external {
        if (msg.sender != owner) revert UnauthorizedOwner(msg.sender);
        RecoveryProposal storage proposal = _proposal(recoveryId);
        if (proposal.status != ProposalStatus.ACTIVE && proposal.status != ProposalStatus.PENDING) {
            revert InvalidProposalStatus(proposal.status);
        }
        proposal.status = ProposalStatus.VETOED;
        proposal.vetoedAt = uint48(block.timestamp);
        for (uint256 index = 0; index < GUARDIAN_COUNT; index++) {
            delete hasApproved[recoveryId][_guardians[index]];
        }
        proposal.approvalCount = 0;
        emit RecoveryVetoed(recoveryId, msg.sender, uint48(block.timestamp));
    }

    /// @notice Executes a queued recovery after the entire 48-hour delay has elapsed.
    function executeRecovery(uint256 recoveryId) external onlyGuardian {
        RecoveryProposal storage proposal = _proposal(recoveryId);
        if (proposal.status != ProposalStatus.PENDING) revert InvalidProposalStatus(proposal.status);
        if (block.timestamp < proposal.executableAfter) {
            revert RecoveryTimelockActive(recoveryId, proposal.executableAfter, block.timestamp);
        }
        proposal.status = ProposalStatus.EXECUTED;
        proposal.executedAt = uint48(block.timestamp);
        if (proposal.target == RecoveryTarget.OWNER) {
            IGuardianRecoveryWallet(wallet).recoverOwnerFromGuardians(proposal.newKey);
        } else {
            IGuardianRecoveryWallet(wallet).recoverAgentFromGuardians(proposal.newKey);
        }
        emit RecoveryExecuted(recoveryId, proposal.newKey, proposal.target, uint48(block.timestamp));
    }

    function _proposal(uint256 recoveryId) internal view returns (RecoveryProposal storage proposal) {
        proposal = proposals[recoveryId];
        if (proposal.id == 0) revert InvalidRecoveryId(recoveryId);
    }
}

interface IGuardianRecoveryWallet {
    function recoverOwnerFromGuardians(address newOwner) external;
    function recoverAgentFromGuardians(address newAgent) external;
}
