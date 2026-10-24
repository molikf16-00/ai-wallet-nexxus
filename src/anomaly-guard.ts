import { keccak256, toUtf8Bytes } from "ethers";
import type { Hex } from "./types.js";

export type PatternClass = "benign" | "malicious";

export interface AnomalyTransaction {
  timestamp: number;
  amountWei: bigint;
  target: string;
  selector: Hex;
  recipient: string;
}

export interface RiskBreakdown {
  velocity: number;
  volatility: number;
  diversity: number;
  timing: number;
  aggregate: number;
  frozen: boolean;
}

export interface AnomalyObservation extends AnomalyTransaction {
  risk: RiskBreakdown;
}

export interface BenchmarkPattern {
  id: string;
  classification: PatternClass;
  transactions: AnomalyTransaction[];
}

export interface BenchmarkMetrics {
  threshold: number;
  totalPatterns: number;
  benignPatterns: number;
  maliciousPatterns: number;
  truePositives: number;
  trueNegatives: number;
  falsePositives: number;
  falseNegatives: number;
  truePositiveDetectionRate: number;
  falseFreezeRate: number;
  meanTimeToContainmentSeconds: number;
  meanTimeToContainmentBlocks: number;
  roc: Array<{ threshold: number; truePositiveRate: number; falsePositiveRate: number }>;
  proofHash: Hex;
}

const DAY = 86_400;
const HOUR = 3_600;
const BASELINE_TPM = 1;
const VELOCITY_MULTIPLIER = 4;
const SCHEDULE_START = 8;
const SCHEDULE_END = 20;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const API_TARGET = "0x8100000000000000000000000000000000000001";
const GROCERY_TARGET = "0x8200000000000000000000000000000000000002";
const API_RECIPIENT = "0x8300000000000000000000000000000000000003";
const GROCERY_RECIPIENT = "0x8400000000000000000000000000000000000004";
const ATTACK_TARGET = "0x8500000000000000000000000000000000000005";
const ATTACK_RECIPIENT = "0x8600000000000000000000000000000000000006";
const API_SELECTOR = (`0x${keccak256(toUtf8Bytes("payCredits(address,uint256)")).slice(2, 10)}`) as Hex;
const GROCERY_SELECTOR = (`0x${keccak256(toUtf8Bytes("checkout(uint256)")).slice(2, 10)}`) as Hex;
const ATTACK_SELECTOR = (`0x${keccak256(toUtf8Bytes("drain(uint256)")).slice(2, 10)}`) as Hex;

export class AnomalyGuardSimulator {
  public readonly threshold: number;
  public readonly alpha: number;
  public frozen = false;
  public lastRisk = 0;
  public lastObservedAt = 0;
  public ewmaTpm = 0;
  public history: Array<{ timestamp: number; amountWei: bigint }> = [];
  public readonly knownInteractions = new Set<string>();
  public readonly knownRecipients = new Set<string>();
  public entropyWindowStart = 0;
  public unfamiliarInteractions = 0;
  public unfamiliarRecipients = 0;
  public frozenAt = 0;

  public constructor(threshold = 75, alpha = 0.25) {
    this.threshold = threshold;
    this.alpha = alpha;
  }

  public seedProfile(transactions: AnomalyTransaction[]): void {
    for (const transaction of transactions) {
      this.observe(transaction, false);
    }
    this.frozen = false;
    this.frozenAt = 0;
    this.lastRisk = 0;
  }

  public observe(transaction: AnomalyTransaction, allowFreeze = true): AnomalyObservation {
    if (this.frozen) {
      return { ...transaction, risk: { velocity: 0, volatility: 0, diversity: 0, timing: 0, aggregate: 100, frozen: true } };
    }
    this.refreshWindows(transaction.timestamp);
    const velocity = this.velocityRisk(transaction.timestamp);
    const volatility = this.volatilityRisk(transaction.amountWei);
    const diversity = this.diversityRisk(transaction);
    const timing = this.timingRisk(transaction.timestamp);
    const aggregate = Math.min(100, velocity + volatility + diversity + timing);
    const shouldFreeze = allowFreeze && aggregate >= this.threshold;
    if (shouldFreeze) {
      this.frozen = true;
      this.frozenAt = transaction.timestamp;
    }
    this.lastRisk = aggregate;
    this.history.push({ timestamp: transaction.timestamp, amountWei: transaction.amountWei });
    if (this.history.length > 2_000) this.history.shift();
    this.updateVelocity(transaction.timestamp);
    this.knownInteractions.add(this.interactionKey(transaction));
    if (transaction.recipient !== ZERO_ADDRESS) this.knownRecipients.add(transaction.recipient.toLowerCase());
    return { ...transaction, risk: { velocity, volatility, diversity, timing, aggregate, frozen: shouldFreeze } };
  }

  public validateAfterFreeze(): void {
    if (this.frozen) throw new Error("AgentKeyFrozen");
  }

  private refreshWindows(timestamp: number): void {
    if (this.entropyWindowStart === 0) this.entropyWindowStart = timestamp;
    if (timestamp >= this.entropyWindowStart + HOUR) {
      this.entropyWindowStart = timestamp;
      this.unfamiliarInteractions = 0;
      this.unfamiliarRecipients = 0;
    }
    const cutoff = timestamp - 7 * DAY;
    while (this.history.length > 0 && this.history[0].timestamp < cutoff) this.history.shift();
  }

  private velocityRisk(timestamp: number): number {
    if (this.lastObservedAt === 0) return 0;
    const delta = Math.max(1, timestamp - this.lastObservedAt);
    const instantaneousTpm = 60 / delta;
    const ewma = this.ewmaTpm === 0 ? instantaneousTpm : this.alpha * instantaneousTpm + (1 - this.alpha) * this.ewmaTpm;
    if (ewma <= BASELINE_TPM * VELOCITY_MULTIPLIER) return 0;
    if (ewma >= BASELINE_TPM * VELOCITY_MULTIPLIER * 2) return 35;
    if (ewma >= BASELINE_TPM * VELOCITY_MULTIPLIER * 1.5) return 28;
    return 22;
  }

  private volatilityRisk(amountWei: bigint): number {
    if (this.history.length < 5) return amountWei > 0n ? 0 : 0;
    const values = this.history.map((item) => Number(item.amountWei));
    const amount = Number(amountWei);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    if (variance === 0) return amount === mean ? 0 : 30;
    const z = Math.abs(amount - mean) / Math.sqrt(variance);
    if (z >= 6) return 30;
    if (z >= 3) return 22;
    if (z >= 2) return 10;
    return 0;
  }

  private diversityRisk(transaction: AnomalyTransaction): number {
    const interaction = this.interactionKey(transaction);
    if (!this.knownInteractions.has(interaction)) this.unfamiliarInteractions += 1;
    if (transaction.recipient !== ZERO_ADDRESS && !this.knownRecipients.has(transaction.recipient.toLowerCase())) this.unfamiliarRecipients += 1;
    const unfamiliar = this.unfamiliarInteractions + this.unfamiliarRecipients;
    if (unfamiliar >= 2) return 30;
    if (unfamiliar === 1) return 10;
    return 0;
  }

  private timingRisk(timestamp: number): number {
    const hour = Math.floor((timestamp % DAY) / HOUR);
    return hour >= SCHEDULE_START && hour < SCHEDULE_END ? 0 : 15;
  }

  private updateVelocity(timestamp: number): void {
    const delta = this.lastObservedAt === 0 ? 60 : Math.max(1, timestamp - this.lastObservedAt);
    const instantaneousTpm = 60 / delta;
    this.ewmaTpm = this.ewmaTpm === 0 ? instantaneousTpm : this.alpha * instantaneousTpm + (1 - this.alpha) * this.ewmaTpm;
    this.lastObservedAt = timestamp;
  }

  private interactionKey(transaction: AnomalyTransaction): string {
    return `${transaction.target.toLowerCase()}:${transaction.selector.toLowerCase()}`;
  }
}

export class AnomalyBenchmark {
  public run(threshold = 75): BenchmarkMetrics {
    const patterns = buildPatterns();
    let truePositives = 0;
    let trueNegatives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    const containmentTimes: number[] = [];
    for (const pattern of patterns) {
      const detector = new AnomalyGuardSimulator(threshold);
      const warmup = pattern.transactions.slice(0, 5);
      detector.seedProfile(warmup);
      let firstFreeze = 0;
      for (const transaction of pattern.transactions.slice(5)) {
        const observation = detector.observe(transaction);
        if (observation.risk.frozen && firstFreeze === 0) firstFreeze = transaction.timestamp - pattern.transactions[0].timestamp;
      }
      if (pattern.classification === "malicious" && detector.frozen) {
        truePositives += 1;
        containmentTimes.push(firstFreeze);
      } else if (pattern.classification === "malicious") {
        falseNegatives += 1;
      } else if (detector.frozen) {
        falsePositives += 1;
      } else {
        trueNegatives += 1;
      }
    }
    const benignPatterns = patterns.filter((pattern) => pattern.classification === "benign").length;
    const maliciousPatterns = patterns.length - benignPatterns;
    const truePositiveDetectionRate = maliciousPatterns === 0 ? 0 : truePositives / maliciousPatterns;
    const falseFreezeRate = benignPatterns === 0 ? 0 : falsePositives / benignPatterns;
    const meanTimeToContainmentSeconds = containmentTimes.length === 0 ? 0 : containmentTimes.reduce((sum, value) => sum + value, 0) / containmentTimes.length;
    const roc = [];
    for (let candidate = 0; candidate <= 100; candidate += 5) {
      const metrics = this.runWithoutRoc(candidate);
      roc.push({ threshold: candidate, truePositiveRate: metrics.truePositiveDetectionRate, falsePositiveRate: metrics.falseFreezeRate });
    }
    const proofHash = keccak256(toUtf8Bytes(JSON.stringify({ threshold, truePositives, trueNegatives, falsePositives, falseNegatives, meanTimeToContainmentSeconds }))) as Hex;
    return {
      threshold,
      totalPatterns: patterns.length,
      benignPatterns,
      maliciousPatterns,
      truePositives,
      trueNegatives,
      falsePositives,
      falseNegatives,
      truePositiveDetectionRate,
      falseFreezeRate,
      meanTimeToContainmentSeconds,
      meanTimeToContainmentBlocks: Math.ceil(meanTimeToContainmentSeconds / 12),
      roc,
      proofHash,
    };
  }

  private runWithoutRoc(threshold: number): { truePositiveDetectionRate: number; falseFreezeRate: number } {
    const patterns = buildPatterns();
    let tp = 0;
    let fp = 0;
    let malicious = 0;
    let benign = 0;
    for (const pattern of patterns) {
      const detector = new AnomalyGuardSimulator(threshold);
      detector.seedProfile(pattern.transactions.slice(0, 5));
      for (const transaction of pattern.transactions.slice(5)) detector.observe(transaction);
      if (pattern.classification === "malicious") {
        malicious += 1;
        if (detector.frozen) tp += 1;
      } else {
        benign += 1;
        if (detector.frozen) fp += 1;
      }
    }
    return { truePositiveDetectionRate: tp / malicious, falseFreezeRate: fp / benign };
  }
}

export function buildPatterns(): BenchmarkPattern[] {
  const patterns: BenchmarkPattern[] = [];
  const base = 1_700_000_000 + 10 * HOUR;
  for (let index = 0; index < 500; index += 1) {
    const grocery = index % 2 === 0;
    const target = grocery ? GROCERY_TARGET : API_TARGET;
    const selector = grocery ? GROCERY_SELECTOR : API_SELECTOR;
    const recipient = grocery ? GROCERY_RECIPIENT : API_RECIPIENT;
    const amount = grocery ? 25_000_000_000_000_000n : 10_000_000_000_000_000n;
    const transactions: AnomalyTransaction[] = [];
    for (let sample = 0; sample < 6; sample += 1) {
      transactions.push({ timestamp: base + index * 300 + sample * DAY, amountWei: amount, target, selector, recipient });
    }
    patterns.push({ id: `benign-${index}`, classification: "benign", transactions });
  }
  for (let index = 0; index < 500; index += 1) {
    const start = base + index * 300;
    const transactions: AnomalyTransaction[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      transactions.push({ timestamp: start + sample * DAY, amountWei: 10_000_000_000_000_000n, target: API_TARGET, selector: API_SELECTOR, recipient: API_RECIPIENT });
    }
    const maliciousTimestamp = Math.floor((start + 5 * DAY) / DAY) * DAY + 2 * HOUR + 2;
    transactions.push({ timestamp: maliciousTimestamp, amountWei: 20n * 10n ** 18n, target: ATTACK_TARGET, selector: ATTACK_SELECTOR, recipient: ATTACK_RECIPIENT });
    patterns.push({ id: `malicious-${index}`, classification: "malicious", transactions });
  }
  return patterns;
}

export const anomalyConstants = {
  API_TARGET,
  GROCERY_TARGET,
  API_RECIPIENT,
  GROCERY_RECIPIENT,
  ATTACK_TARGET,
  ATTACK_RECIPIENT,
  API_SELECTOR,
  GROCERY_SELECTOR,
  ATTACK_SELECTOR,
};
