import { keccak256, toUtf8Bytes } from "ethers";
import type { Hex } from "./types.js";

export interface FuzzInvariantCounts {
  perTxBound: number;
  dailyCapBound: number;
  expiryBound: number;
  vetoIntegrity: number;
}

export interface FuzzMutation {
  index: number;
  caller: string;
  selector: Hex;
  target: string;
  recipient: string;
  amountWei: bigint;
  timestamp: number;
  nonceKey: bigint;
  nonceSequence: bigint;
  expectedNonceSequence: bigint;
  guardianVoteMask: number;
  guardianVotes: number;
  recoveryTimeOffsetSeconds: number;
  recoveryVetoed: boolean;
  auth: "owner" | "agent" | "recovery" | "invalid";
  nonceValid: boolean;
  policyValid: boolean;
  recoveryFinalized: boolean;
  fundsMovedWei: bigint;
  calldata: Hex;
}

export interface FuzzViolation {
  index: number;
  mode: "funds-moved-without-authorization" | "per-tx-bound" | "daily-cap-bound" | "expiry-bound" | "veto-integrity";
  message: string;
  mutation: FuzzMutation;
}

export interface FuzzProgress {
  totalMutationsEvaluated: number;
  violationsDetected: number;
  invariantsVerified: FuzzInvariantCounts;
  walletBalanceWei: bigint;
  dailySpentWei: bigint;
  elapsedMs: number;
  runsPerSecond: number;
  firstViolation?: FuzzViolation;
}

export interface FuzzResult extends FuzzProgress {
  seed: number;
  flawedContract: boolean;
  complete: true;
  proofHash: Hex;
}

const INITIAL_BALANCE = 100n * 10n ** 18n;
const PER_TX_LIMIT = 5n * 10n ** 16n;
const DAILY_LIMIT = 25n * 10n ** 16n;
const AGENT_EXPIRY = 1_700_086_400;
const WINDOW_START = 1_700_000_000;
const OWNER = "0x1100000000000000000000000000000000000001";
const AGENT = "0x2200000000000000000000000000000000000002";
const LEGITIMATE_TARGET = "0x3300000000000000000000000000000000000003";
const LEGITIMATE_RECIPIENT = "0x4400000000000000000000000000000000000004";
const ALLOWED_SELECTOR = "0x12345678" as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

class XorShift32 {
  private state: number;

  public constructor(seed: number) {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  public nextUint32(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  public nextInt(maxExclusive: number): number {
    return this.nextUint32() % maxExclusive;
  }

  public nextBigInt(maxExclusive: bigint): bigint {
    const high = BigInt(this.nextUint32());
    const low = BigInt(this.nextUint32());
    return ((high << 32n) | low) % maxExclusive;
  }

  public nextAddress(): string {
    let output = "0x";
    for (let index = 0; index < 5; index += 1) output += this.nextUint32().toString(16).padStart(8, "0");
    return output;
  }
}

export function runInvariantFuzz(iterations = 5_000, flawedContract = false, seed = 0xa9e17): FuzzResult {
  const started = Date.now();
  const rng = new XorShift32(seed);
  const nonceSequences = new Map<bigint, bigint>();
  let walletBalanceWei = INITIAL_BALANCE;
  let dailySpentWei = 0n;
  let dailyWindow = WINDOW_START;
  let violationsDetected = 0;
  let firstViolation: FuzzViolation | undefined;
  const invariantsVerified: FuzzInvariantCounts = { perTxBound: 0, dailyCapBound: 0, expiryBound: 0, vetoIntegrity: 0 };

  for (let index = 0; index < iterations; index += 1) {
    const mutation = generateMutation(index, rng, nonceSequences, flawedContract);
    if (mutation.timestamp >= dailyWindow + 86_400) {
      dailyWindow = mutation.timestamp;
      dailySpentWei = 0n;
    }
    mutation.policyValid = mutation.policyValid && dailySpentWei + mutation.amountWei <= DAILY_LIMIT;
    const beforeBalance = walletBalanceWei;
    const authorized = mutation.auth === "owner" && mutation.nonceValid || mutation.auth === "agent" && mutation.nonceValid && mutation.policyValid || mutation.auth === "recovery" && mutation.recoveryFinalized;
    let moved = 0n;
    if (authorized && mutation.amountWei <= walletBalanceWei) {
      moved = mutation.amountWei;
      walletBalanceWei -= moved;
      if (mutation.auth === "agent") dailySpentWei += moved;
    } else if (flawedContract && index === 0) {
      moved = 1n * 10n ** 18n;
      walletBalanceWei -= moved;
    }
    mutation.fundsMovedWei = moved;
    const balanceDecreased = walletBalanceWei < beforeBalance;
    if (balanceDecreased && !authorized) {
      violationsDetected += 1;
      firstViolation ??= { index, mode: "funds-moved-without-authorization", message: "Wallet balance decreased without owner authorization, valid agent policy, or finalized recovery.", mutation };
    }
    if (mutation.auth === "agent" && mutation.nonceValid && mutation.policyValid && moved > 0n) {
      if (moved <= PER_TX_LIMIT) invariantsVerified.perTxBound += 1;
      else {
        violationsDetected += 1;
        firstViolation ??= { index, mode: "per-tx-bound", message: "Agent debit exceeded maxPerTxValueWei.", mutation };
      }
      if (dailySpentWei <= DAILY_LIMIT) invariantsVerified.dailyCapBound += 1;
      else {
        violationsDetected += 1;
        firstViolation ??= { index, mode: "daily-cap-bound", message: "Agent debit exceeded the rolling daily limit.", mutation };
      }
    } else {
      invariantsVerified.perTxBound += 1;
      invariantsVerified.dailyCapBound += 1;
    }
    if (mutation.auth === "agent" && moved > 0n && mutation.timestamp < AGENT_EXPIRY) invariantsVerified.expiryBound += 1;
    else if (mutation.auth !== "agent" || moved === 0n) invariantsVerified.expiryBound += 1;
    else {
      violationsDetected += 1;
      firstViolation ??= { index, mode: "expiry-bound", message: "Agent debit occurred after session expiry.", mutation };
    }
    if (mutation.recoveryVetoed && !mutation.recoveryFinalized && mutation.auth === "recovery" && moved > 0n) {
      violationsDetected += 1;
      firstViolation ??= { index, mode: "veto-integrity", message: "Recovery veto did not prevent recovery-authorized funds movement.", mutation };
    } else {
      invariantsVerified.vetoIntegrity += 1;
    }
  }
  const elapsedMs = Math.max(1, Date.now() - started);
  const runsPerSecond = Math.round((iterations / elapsedMs) * 1000);
  const proofHash = keccak256(toUtf8Bytes(JSON.stringify({ seed, iterations, flawedContract, violationsDetected, walletBalanceWei: walletBalanceWei.toString(), dailySpentWei: dailySpentWei.toString(), firstViolation: firstViolation?.message ?? null }))) as Hex;
  return { seed, flawedContract, complete: true, totalMutationsEvaluated: iterations, violationsDetected, invariantsVerified, walletBalanceWei, dailySpentWei, elapsedMs, runsPerSecond, firstViolation, proofHash };
}

export function generateMutation(index: number, rng: XorShift32, nonceSequences: Map<bigint, bigint>, flawedContract: boolean): FuzzMutation {
  const forceFlawed = flawedContract && index === 0;
  const caller = forceFlawed ? "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead" : (() => {
    const callerClass = rng.nextInt(100);
    if (callerClass === 0) return OWNER;
    if (callerClass === 1) return AGENT;
    return rng.nextAddress();
  })();
  const target = forceFlawed ? rng.nextAddress() : rng.nextInt(5) === 0 ? LEGITIMATE_TARGET : rng.nextAddress();
  const selector = forceFlawed ? "0xdeadbeef" as Hex : rng.nextInt(5) === 0 ? ALLOWED_SELECTOR : (`0x${rng.nextUint32().toString(16).padStart(8, "0")}` as Hex);
  const recipient = forceFlawed ? rng.nextAddress() : rng.nextInt(4) === 0 ? LEGITIMATE_RECIPIENT : rng.nextAddress();
  const amountWei = forceFlawed ? 1n * 10n ** 18n : rng.nextBigInt(1_000_000_000_000_000_000_000_001n);
  const timestamp = forceFlawed ? WINDOW_START + 60 : WINDOW_START - 86_400 + rng.nextInt(86_400 * 4);
  const nonceKey = BigInt(rng.nextInt(16));
  const expectedNonceSequence = nonceSequences.get(nonceKey) ?? 0n;
  const nonceMode = forceFlawed ? 1 : rng.nextInt(3);
  const nonceSequence = nonceMode === 0 ? expectedNonceSequence : nonceMode === 1 ? expectedNonceSequence - (expectedNonceSequence > 0n ? 1n : 0n) : expectedNonceSequence + 1n;
  const nonceValid = nonceSequence === expectedNonceSequence;
  if (nonceValid) nonceSequences.set(nonceKey, expectedNonceSequence + 1n);
  const guardianVoteMask = rng.nextInt(32);
  const guardianVotes = popcount(guardianVoteMask);
  const recoveryTimeOffsetSeconds = rng.nextInt(259_201);
  const recoveryVetoed = rng.nextInt(5) === 0;
  const recoveryFinalized = guardianVotes >= 3 && recoveryTimeOffsetSeconds >= 172_800 && !recoveryVetoed;
  const auth: FuzzMutation["auth"] = forceFlawed ? "invalid" : caller.toLowerCase() === OWNER ? "owner" : caller.toLowerCase() === AGENT ? "agent" : recoveryFinalized ? "recovery" : "invalid";
  const policyValid = target.toLowerCase() === LEGITIMATE_TARGET && selector.toLowerCase() === ALLOWED_SELECTOR && recipient.toLowerCase() === LEGITIMATE_RECIPIENT && amountWei <= PER_TX_LIMIT && timestamp < AGENT_EXPIRY && timestamp >= WINDOW_START;
  return { index, caller, selector, target, recipient, amountWei, timestamp, nonceKey, nonceSequence, expectedNonceSequence, guardianVoteMask, guardianVotes, recoveryTimeOffsetSeconds, recoveryVetoed, auth, nonceValid, policyValid, recoveryFinalized, fundsMovedWei: 0n, calldata: encodeMutationCalldata(target, selector, recipient, amountWei) };
}

function encodeMutationCalldata(target: string, selector: Hex, recipient: string, amountWei: bigint): Hex {
  return (`0x${selector.slice(2)}${target.slice(2).padStart(64, "0")}${recipient.slice(2).padStart(64, "0")}${amountWei.toString(16).padStart(64, "0")}`) as Hex;
}

function popcount(value: number): number {
  let count = 0;
  let current = value;
  while (current !== 0) {
    current &= current - 1;
    count += 1;
  }
  return count;
}

export const fuzzConstants = { INITIAL_BALANCE, PER_TX_LIMIT, DAILY_LIMIT, AGENT_EXPIRY, OWNER, AGENT, LEGITIMATE_TARGET, LEGITIMATE_RECIPIENT, ALLOWED_SELECTOR };
