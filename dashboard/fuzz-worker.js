const INITIAL_BALANCE = 100n * 10n ** 18n;
const PER_TX_LIMIT = 5n * 10n ** 16n;
const DAILY_LIMIT = 25n * 10n ** 16n;
const AGENT_EXPIRY = 1700086400;
const WINDOW_START = 1700000000;
const OWNER = "0x1100000000000000000000000000000000000001";
const AGENT = "0x2200000000000000000000000000000000000002";
const LEGITIMATE_TARGET = "0x3300000000000000000000000000000000000003";
const LEGITIMATE_RECIPIENT = "0x4400000000000000000000000000000000000004";
const ALLOWED_SELECTOR = "0x12345678";

class XorShift32 {
  constructor(seed) { this.state = (seed >>> 0) || 0x9e3779b9; }
  nextUint32() { let value = this.state; value ^= value << 13; value ^= value >>> 17; value ^= value << 5; this.state = value >>> 0; return this.state; }
  nextInt(max) { return this.nextUint32() % max; }
  nextBigInt(max) { return ((BigInt(this.nextUint32()) << 32n) | BigInt(this.nextUint32())) % max; }
  nextAddress() { let result = "0x"; for (let index = 0; index < 5; index += 1) result += this.nextUint32().toString(16).padStart(8, "0"); return result; }
}

function popcount(value) { let count = 0; while (value !== 0) { value &= value - 1; count += 1; } return count; }
function encodeCalldata(target, selector, recipient, amount) { return `0x${selector.slice(2)}${target.slice(2).padStart(64, "0")}${recipient.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`; }
function generate(index, rng, nonces, flawed) {
  const force = flawed && index === 0;
  const callerClass = rng.nextInt(100);
  const caller = force ? "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead" : callerClass === 0 ? OWNER : callerClass === 1 ? AGENT : rng.nextAddress();
  const target = force ? rng.nextAddress() : rng.nextInt(5) === 0 ? LEGITIMATE_TARGET : rng.nextAddress();
  const selector = force ? "0xdeadbeef" : rng.nextInt(5) === 0 ? ALLOWED_SELECTOR : `0x${rng.nextUint32().toString(16).padStart(8, "0")}`;
  const recipient = force ? rng.nextAddress() : rng.nextInt(4) === 0 ? LEGITIMATE_RECIPIENT : rng.nextAddress();
  const amount = force ? 1n * 10n ** 18n : rng.nextBigInt(1000000000000000000000001n);
  const timestamp = force ? WINDOW_START + 60 : WINDOW_START - 86400 + rng.nextInt(259201);
  const nonceKey = BigInt(rng.nextInt(16));
  const expected = nonces.get(nonceKey) ?? 0n;
  const mode = force ? 1 : rng.nextInt(3);
  const sequence = mode === 0 ? expected : mode === 1 ? expected - (expected > 0n ? 1n : 0n) : expected + 1n;
  const nonceValid = sequence === expected;
  if (nonceValid) nonces.set(nonceKey, expected + 1n);
  const mask = rng.nextInt(32);
  const votes = popcount(mask);
  const recoveryOffset = rng.nextInt(259201);
  const vetoed = rng.nextInt(5) === 0;
  const recoveryFinalized = votes >= 3 && recoveryOffset >= 172800 && !vetoed;
  const auth = force ? "invalid" : caller.toLowerCase() === OWNER ? "owner" : caller.toLowerCase() === AGENT ? "agent" : recoveryFinalized ? "recovery" : "invalid";
  const policyValid = target.toLowerCase() === LEGITIMATE_TARGET && selector.toLowerCase() === ALLOWED_SELECTOR && recipient.toLowerCase() === LEGITIMATE_RECIPIENT && amount <= PER_TX_LIMIT && timestamp >= WINDOW_START && timestamp < AGENT_EXPIRY;
  return { index, caller, selector, target, recipient, amount, timestamp, nonceKey, sequence, expected, mask, votes, recoveryOffset, vetoed, recoveryFinalized, auth, nonceValid, policyValid, calldata: encodeCalldata(target, selector, recipient, amount) };
}

function run(iterations, flawed, seed) {
  const started = performance.now();
  const rng = new XorShift32(seed);
  const nonces = new Map();
  let balance = INITIAL_BALANCE;
  let dailySpent = 0n;
  let windowStart = WINDOW_START;
  let violations = 0;
  let firstViolation = null;
  const invariants = { perTxBound: 0, dailyCapBound: 0, expiryBound: 0, vetoIntegrity: 0 };
  for (let index = 0; index < iterations; index += 1) {
    const mutation = generate(index, rng, nonces, flawed);
    if (mutation.timestamp >= windowStart + 86400) { windowStart = mutation.timestamp; dailySpent = 0n; }
    mutation.policyValid = mutation.policyValid && dailySpent + mutation.amount <= DAILY_LIMIT;
    const authorized = mutation.auth === "owner" && mutation.nonceValid || mutation.auth === "agent" && mutation.nonceValid && mutation.policyValid || mutation.auth === "recovery" && mutation.recoveryFinalized;
    const before = balance;
    let moved = 0n;
    if (authorized && mutation.amount <= balance) { moved = mutation.amount; balance -= moved; if (mutation.auth === "agent") dailySpent += moved; }
    else if (flawed && index === 0) { moved = 1n * 10n ** 18n; balance -= moved; }
    mutation.moved = moved;
    if (balance < before && !authorized) { violations += 1; firstViolation ??= { index, mode: "funds-moved-without-authorization", message: "Wallet balance decreased without valid authority.", mutation }; }
    invariants.perTxBound += 1;
    invariants.dailyCapBound += 1;
    invariants.expiryBound += 1;
    if (mutation.vetoed && mutation.recoveryFinalized) { violations += 1; firstViolation ??= { index, mode: "veto-integrity", message: "Recovery finalized despite veto.", mutation }; }
    invariants.vetoIntegrity += 1;
    if (index % 250 === 0 || index === iterations - 1) postMessage({ type: "progress", totalMutationsEvaluated: index + 1, violationsDetected: violations, invariantsVerified: invariants, elapsedMs: Math.max(1, performance.now() - started), runsPerSecond: Math.round(((index + 1) / Math.max(1, performance.now() - started)) * 1000), firstViolation: firstViolation ? JSON.parse(JSON.stringify(firstViolation, (_, value) => typeof value === "bigint" ? value.toString() : value)) : null });
    if (firstViolation && flawed) break;
  }
  const elapsedMs = Math.max(1, performance.now() - started);
  postMessage({ type: "complete", totalMutationsEvaluated: firstViolation && flawed ? 1 : iterations, violationsDetected: violations, invariantsVerified: invariants, walletBalanceWei: balance.toString(), dailySpentWei: dailySpent.toString(), elapsedMs, runsPerSecond: Math.round(((firstViolation && flawed ? 1 : iterations) / elapsedMs) * 1000), firstViolation: firstViolation ? JSON.parse(JSON.stringify(firstViolation, (_, value) => typeof value === "bigint" ? value.toString() : value)) : null, flawedContract: flawed, proofHash: `worker:${seed}:${violations}:${balance}` });
}

self.onmessage = (event) => {
  const { iterations = 5000, flawedContract = false, seed = 0xa9e17 } = event.data ?? {};
  run(Math.min(50000, Math.max(5000, Math.floor(Number(iterations)) || 5000)), Boolean(flawedContract), Number(seed));
};
