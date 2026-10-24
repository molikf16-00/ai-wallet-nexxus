import assert from "node:assert/strict";
import { AttackExecutionEngine, ATTACK_CATALOG } from "../src/attack-suite.js";

const engine = new AttackExecutionEngine();
const results = engine.runAll();

assert.equal(results.length, 6);
assert.deepEqual(results.map((result) => result.id), ATTACK_CATALOG.map((entry) => entry.id));
for (const result of results) {
  assert.equal(result.passed, true, result.id);
  assert.ok(result.proof.hash.startsWith("0x"), result.id);
  assert.ok(result.steps.some((step) => step.phase === "proof" && step.status === "verified"), result.id);
  if (result.id !== "paymaster-siphon") {
    assert.ok(BigInt(result.lossWei) <= BigInt(result.dailyLimitWei), result.id);
  } else {
    assert.ok(BigInt(result.gasLoss) <= 500_000n, result.id);
  }
}

const microDrain = results.find((result) => result.id === "micro-drain");
assert.ok(microDrain);
assert.equal(microDrain.metrics.successful, "6");
assert.equal(microDrain.metrics.reverted, "44");
assert.equal(BigInt(microDrain.lossWei), 240000000000000000n);

const paymaster = results.find((result) => result.id === "paymaster-siphon");
assert.ok(paymaster);
assert.equal(paymaster.metrics.accepted, "25");
assert.equal(paymaster.metrics.refused, "25");
assert.equal(paymaster.gasLoss, "500000");

console.log("6 adversarial attack simulations passed with bounded-loss proofs.");
