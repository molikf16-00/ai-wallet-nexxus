import { keccak256, toUtf8Bytes } from "ethers";
import type { Hex } from "./types.js";

export type RecoveryTarget = "owner" | "agent";
export type RecoveryStatus = "none" | "active" | "pending" | "executed" | "vetoed";

export interface Guardian {
  id: string;
  name: string;
  address: string;
}

export interface RecoveryProposal {
  id: number;
  proposer: string;
  newKey: string;
  target: RecoveryTarget;
  status: RecoveryStatus;
  approvals: string[];
  createdAt: number;
  executableAfter: number;
  executedAt: number;
  vetoedAt: number;
}

export interface RecoveryAuditEvent {
  timestamp: number;
  action: "configured" | "initiated" | "approved" | "queued" | "vetoed" | "fast-forwarded" | "executed";
  actor: string;
  recoveryId?: number;
  details: Record<string, string>;
  hash: Hex;
}

export interface RecoveryState {
  owner: string;
  agentKey: string;
  guardians: Guardian[];
  proposal: RecoveryProposal | null;
  now: number;
  audit: RecoveryAuditEvent[];
  quorum: number;
  delaySeconds: number;
}

const DELAY_SECONDS = 172_800;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const DEFAULT_GUARDIANS: Guardian[] = [
  { id: "alice", name: "Alice", address: "0x9100000000000000000000000000000000000001" },
  { id: "bob", name: "Bob", address: "0x9200000000000000000000000000000000000002" },
  { id: "charlie", name: "Charlie", address: "0x9300000000000000000000000000000000000003" },
  { id: "dave", name: "Dave", address: "0x9400000000000000000000000000000000000004" },
  { id: "elena", name: "Elena", address: "0x9500000000000000000000000000000000000005" },
];

export class RecoveryStateError extends Error {
  public constructor(public readonly code: string, message = code) {
    super(message);
    this.name = "RecoveryStateError";
  }
}

export class GuardianRecoverySimulator {
  public owner: string;
  public agentKey: string;
  public readonly guardians: Guardian[];
  public readonly quorum = 3;
  public readonly delaySeconds = DELAY_SECONDS;
  public now: number;
  public proposal: RecoveryProposal | null = null;
  public readonly audit: RecoveryAuditEvent[] = [];

  public constructor(owner: string, agentKey: string, now = 1_700_000_000, guardians = DEFAULT_GUARDIANS) {
    this.owner = owner.toLowerCase();
    this.agentKey = agentKey.toLowerCase();
    this.now = now;
    this.guardians = guardians.map((guardian) => ({ ...guardian, address: guardian.address.toLowerCase() }));
    this.record("configured", this.owner, { guardians: String(this.guardians.length), quorum: String(this.quorum) });
  }

  public getState(): RecoveryState {
    return {
      owner: this.owner,
      agentKey: this.agentKey,
      guardians: this.guardians.map((guardian) => ({ ...guardian })),
      proposal: this.proposal ? { ...this.proposal, approvals: [...this.proposal.approvals] } : null,
      now: this.now,
      audit: this.audit.map((event) => ({ ...event, details: { ...event.details } })),
      quorum: this.quorum,
      delaySeconds: this.delaySeconds,
    };
  }

  public initiateRecovery(guardianAddress: string, newKey: string, target: RecoveryTarget): RecoveryProposal {
    this.assertGuardian(guardianAddress);
    if (newKey.toLowerCase() === ZERO_ADDRESS) throw new RecoveryStateError("InvalidNewKey");
    if (this.proposal && (this.proposal.status === "active" || this.proposal.status === "pending")) {
      throw new RecoveryStateError("RecoveryAlreadyActive");
    }
    this.proposal = {
      id: (this.proposal?.id ?? 0) + 1,
      proposer: guardianAddress.toLowerCase(),
      newKey: newKey.toLowerCase(),
      target,
      status: "active",
      approvals: [],
      createdAt: this.now,
      executableAfter: 0,
      executedAt: 0,
      vetoedAt: 0,
    };
    this.record("initiated", guardianAddress, { newKey: newKey.toLowerCase(), target }, this.proposal.id);
    return this.proposal;
  }

  public approveRecovery(guardianAddress: string): RecoveryProposal {
    this.assertGuardian(guardianAddress);
    const proposal = this.requireProposal();
    if (proposal.status !== "active") throw new RecoveryStateError("InvalidProposalStatus");
    const guardian = guardianAddress.toLowerCase();
    if (proposal.approvals.includes(guardian)) throw new RecoveryStateError("GuardianAlreadyApproved");
    proposal.approvals.push(guardian);
    this.record("approved", guardian, { approvals: String(proposal.approvals.length), quorum: String(this.quorum) }, proposal.id);
    if (proposal.approvals.length >= this.quorum) {
      proposal.status = "pending";
      proposal.executableAfter = this.now + this.delaySeconds;
      this.record("queued", guardian, { executableAfter: String(proposal.executableAfter), delaySeconds: String(this.delaySeconds) }, proposal.id);
    }
    return proposal;
  }

  public vetoRecovery(ownerAddress: string): RecoveryProposal {
    if (ownerAddress.toLowerCase() !== this.owner) throw new RecoveryStateError("UnauthorizedOwner");
    const proposal = this.requireProposal();
    if (proposal.status !== "active" && proposal.status !== "pending") throw new RecoveryStateError("InvalidProposalStatus");
    proposal.status = "vetoed";
    proposal.vetoedAt = this.now;
    proposal.approvals = [];
    this.record("vetoed", ownerAddress, { approvalsReset: "true" }, proposal.id);
    return proposal;
  }

  public fastForward(seconds = this.delaySeconds): RecoveryState {
    if (!Number.isInteger(seconds) || seconds < 0) throw new RecoveryStateError("InvalidTimeDelta");
    this.now += seconds;
    this.record("fast-forwarded", "simulator", { seconds: String(seconds), now: String(this.now) }, this.proposal?.id);
    return this.getState();
  }

  public executeRecovery(guardianAddress: string): RecoveryProposal {
    this.assertGuardian(guardianAddress);
    const proposal = this.requireProposal();
    if (proposal.status !== "pending") throw new RecoveryStateError("InvalidProposalStatus");
    if (this.now < proposal.executableAfter) throw new RecoveryStateError("RecoveryTimelockActive");
    proposal.status = "executed";
    proposal.executedAt = this.now;
    if (proposal.target === "owner") this.owner = proposal.newKey;
    else this.agentKey = proposal.newKey;
    this.record("executed", guardianAddress, { newKey: proposal.newKey, target: proposal.target, compromisedKeyRevoked: "true" }, proposal.id);
    return proposal;
  }

  private requireProposal(): RecoveryProposal {
    if (!this.proposal) throw new RecoveryStateError("InvalidRecoveryId");
    return this.proposal;
  }

  private assertGuardian(address: string): void {
    if (!this.guardians.some((guardian) => guardian.address === address.toLowerCase())) throw new RecoveryStateError("UnauthorizedGuardian");
  }

  private record(action: RecoveryAuditEvent["action"], actor: string, details: Record<string, string>, recoveryId?: number): void {
    const payload = JSON.stringify({ timestamp: this.now, action, actor: actor.toLowerCase(), recoveryId: recoveryId ?? null, details });
    this.audit.push({ timestamp: this.now, action, actor: actor.toLowerCase(), recoveryId, details, hash: keccak256(toUtf8Bytes(payload)) as Hex });
  }
}
