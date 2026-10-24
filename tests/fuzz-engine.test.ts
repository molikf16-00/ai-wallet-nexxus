import assert from "node:assert/strict";
import { runInvariantFuzz } from "../src/fuzz-engine.js";

const safe = runInvariantFuzz(10_000, false, 0xfeedcafe);
assert.equal(safe.complete, true);
assert.equal(safe.totalMutationsEvaluated, 10_000);
assert.equal(safe.violationsDetected, 0);
assert.equal(safe.invariantsVerified.perTxBound, 10_000);
assert.equal(safe.invariantsVerified.dailyCapBound, 10_000);
assert.equal(safe.invariantsVerified.expiryBound, 10_000);
assert.equal(safe.invariantsVerified.vetoIntegrity, 10_000);
assert.ok(safe.runsPerSecond > 0);
assert.ok(safe.proofHash.startsWith("0x"));

const flawed = runInvariantFuzz(5_000, true, 0xfeedcafe);
assert.equal(flawed.complete, true);
assert.ok(flawed.violationsDetected > 0);
assert.equal(flawed.firstViolation?.mode, "funds-moved-without-authorization");
assert.equal(flawed.firstViolation?.mutation.calldata.slice(0, 10), "0xdeadbeef");

console.log(`Invariant fuzz passed: ${safe.totalMutationsEvaluated} safe mutations, ${flawed.violationsDetected} flawed-contract counterexample(s).`);
