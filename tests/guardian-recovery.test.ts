import assert from "node:assert/strict";
import { GuardianRecoverySimulator, DEFAULT_GUARDIANS, RecoveryStateError } from "../src/guardian-recovery.js";

const owner = "0xa100000000000000000000000000000000000001";
const oldAgent = "0xa200000000000000000000000000000000000002";
const newAgent = "0xa300000000000000000000000000000000000003";
const recovery = new GuardianRecoverySimulator(owner, oldAgent);

const proposal = recovery.initiateRecovery(DEFAULT_GUARDIANS[0].address, newAgent, "agent");
recovery.approveRecovery(DEFAULT_GUARDIANS[0].address);
recovery.approveRecovery(DEFAULT_GUARDIANS[1].address);
assert.equal(recovery.getState().proposal?.status, "active");
recovery.approveRecovery(DEFAULT_GUARDIANS[2].address);
assert.equal(recovery.getState().proposal?.status, "pending");
assert.equal(recovery.getState().proposal?.executableAfter, recovery.getState().now + 172_800);
assert.throws(() => recovery.executeRecovery(DEFAULT_GUARDIANS[3].address), (error: unknown) => error instanceof RecoveryStateError && error.code === "RecoveryTimelockActive");
recovery.fastForward(172_800);
recovery.executeRecovery(DEFAULT_GUARDIANS[3].address);
assert.equal(recovery.agentKey, newAgent);
assert.equal(recovery.getState().proposal?.status, "executed");

const vetoed = new GuardianRecoverySimulator(owner, oldAgent);
vetoed.initiateRecovery(DEFAULT_GUARDIANS[0].address, newAgent, "owner");
vetoed.approveRecovery(DEFAULT_GUARDIANS[0].address);
vetoed.approveRecovery(DEFAULT_GUARDIANS[1].address);
vetoed.approveRecovery(DEFAULT_GUARDIANS[2].address);
vetoed.vetoRecovery(owner);
assert.equal(vetoed.getState().proposal?.status, "vetoed");
assert.deepEqual(vetoed.getState().proposal?.approvals, []);
assert.throws(() => vetoed.fastForward(172_800) && vetoed.executeRecovery(DEFAULT_GUARDIANS[0].address), (error: unknown) => error instanceof RecoveryStateError && error.code === "InvalidProposalStatus");
assert.ok(vetoed.getState().audit.some((event) => event.action === "vetoed"));

console.log("Guardian recovery quorum, timelock, veto, reset, and execution tests passed.");

assert.throws(() => new GuardianRecoverySimulator(owner, oldAgent).initiateRecovery(DEFAULT_GUARDIANS[0].address, "not-an-address", "agent"), /InvalidNewKey/);
assert.throws(() => new GuardianRecoverySimulator(owner, oldAgent).initiateRecovery(DEFAULT_GUARDIANS[0].address, "0x0000000000000000000000000000000000000000", "agent"), /InvalidNewKey/);
