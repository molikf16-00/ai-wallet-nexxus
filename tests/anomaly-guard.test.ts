import assert from "node:assert/strict";
import { AnomalyBenchmark, AnomalyGuardSimulator, anomalyConstants, buildPatterns } from "../src/anomaly-guard.js";

const benchmark = new AnomalyBenchmark();
const metrics = benchmark.run(75);

assert.equal(metrics.totalPatterns, 1_000);
assert.equal(metrics.benignPatterns, 500);
assert.equal(metrics.maliciousPatterns, 500);
assert.ok(metrics.truePositiveDetectionRate > 0.96, `TPR ${metrics.truePositiveDetectionRate}`);
assert.ok(metrics.falseFreezeRate < 0.025, `FPR ${metrics.falseFreezeRate}`);
assert.equal(metrics.meanTimeToContainmentSeconds, 0, "single attack inputs are detected immediately; training history must not count toward latency");
assert.ok(metrics.meanTimeToContainmentBlocks >= 0);
assert.ok(metrics.proofHash.startsWith("0x"));
assert.equal(metrics.roc.length, 21);

const detector = new AnomalyGuardSimulator(75);
const benign = buildPatterns()[0].transactions;
detector.seedProfile(benign);
const observation = detector.observe({
  timestamp: benign[benign.length - 1].timestamp + 1,
  amountWei: 20n * 10n ** 18n,
  target: anomalyConstants.ATTACK_TARGET,
  selector: anomalyConstants.ATTACK_SELECTOR,
  recipient: anomalyConstants.ATTACK_RECIPIENT,
});
assert.equal(observation.risk.frozen, true);
assert.equal(detector.frozen, true);
assert.throws(() => detector.validateAfterFreeze(), /AgentKeyFrozen/);

console.log(`Anomaly benchmark passed: TPR ${(metrics.truePositiveDetectionRate * 100).toFixed(2)}%, FFR ${(metrics.falseFreezeRate * 100).toFixed(2)}%, MTTC ${metrics.meanTimeToContainmentSeconds.toFixed(2)}s.`);
