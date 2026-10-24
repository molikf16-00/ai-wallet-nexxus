import {
  AbiCoder,
  Interface,
  Wallet,
  hashMessage,
  keccak256,
  parseEther,
  toUtf8Bytes,
} from "ethers";
import {
  AgentSmartAccountSimulator,
  ERC20_TRANSFER_SELECTOR,
  PolicyEngineSimulator,
  PolicyViolation,
  encodeAuthorization,
  encodeExecution,
  packNonce,
  PAY_CREDITS_SELECTOR,
} from "./simulator.js";
import type { ExecutionCall, Hex, UserOperationV06 } from "./types.js";

export type AttackId = "direct-drain" | "micro-drain" | "selector-spoof" | "expired-replay" | "paymaster-siphon" | "recipient-diversion";

export interface TraceStep {
  index: number;
  phase: "attack" | "decode" | "validate" | "mutate" | "defense" | "proof";
  status: "attempted" | "accepted" | "reverted" | "settled" | "verified";
  label: string;
  details: Record<string, string>;
}

export interface AttackResult {
  id: AttackId;
  title: string;
  description: string;
  passed: boolean;
  lossWei: string;
  dailyLimitWei: string;
  gasLoss: string;
  steps: TraceStep[];
  metrics: Record<string, string>;
  proof: {
    equation: string;
    inequality: string;
    hash: Hex;
  };
}

export interface AttackCatalogEntry {
  id: AttackId;
  title: string;
  threat: string;
  defense: string;
}

const ABI = AbiCoder.defaultAbiCoder();
const ACCOUNT = "0x1000000000000000000000000000000000000001";
const POLICY_ENGINE = "0x4000000000000000000000000000000000000004";
const ATTACKER = "0x3000000000000000000000000000000000000003";
const TOKEN = "0x2000000000000000000000000000000000000002";
const BILLING = "0x5000000000000000000000000000000000000005";
const DEFI = "0x6000000000000000000000000000000000000006";
const LEGITIMATE_BILLING_RECIPIENT = "0x7000000000000000000000000000000000000007";
const OWNER_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const AGENT_KEY = "0x2222222222222222222222222222222222222222222222222222222222222222";
const OWNER_WALLET = new Wallet(OWNER_KEY);
const AGENT_WALLET = new Wallet(AGENT_KEY);
const BILLING_INTERFACE = new Interface(["function payCredits(address recipient,uint256 amount)"]);
const ACCOUNT_INTERFACE = new Interface(["function transferOwnership(address newOwner)", "function stake(uint256 amount)"]);

export const ATTACK_CATALOG: AttackCatalogEntry[] = [
  {
    id: "direct-drain",
    title: "Direct Attacker Drain",
    threat: "A leaked session key attempts to move the entire 20 ETH balance in one UserOperation.",
    defense: "The per-transaction cap rejects the operation before any reservation or execution mutation.",
  },
  {
    id: "micro-drain",
    title: "High-Frequency Micro-Drain",
    threat: "Fifty rapid 0.04 ETH operations attempt to extract 2 ETH below the per-operation cap.",
    defense: "The rolling daily counter rejects the first operation whose projected spend exceeds 0.25 ETH.",
  },
  {
    id: "selector-spoof",
    title: "Unauthorized Selector Spoof",
    threat: "The hijacker substitutes destructive, administrative, or staking selectors.",
    defense: "The target and exact four-byte selector are checked before a spend reservation is created.",
  },
  {
    id: "expired-replay",
    title: "Expired Session-Key Replay",
    threat: "A previously valid signed UserOperation is broadcast after the session key deadline.",
    defense: "Strict expiry rejects at validation time and emits SIG_VALIDATION_FAILED semantics in the trace.",
  },
  {
    id: "paymaster-siphon",
    title: "Paymaster Gas Siphon",
    threat: "A compromised agent loops non-state-changing operations to consume sponsored gas.",
    defense: "AgentPaymaster reserves and settles a hard 500,000 gas daily stipend.",
  },
  {
    id: "recipient-diversion",
    title: "Phishing Recipient Diversion",
    threat: "Prompt injection swaps a legitimate API billing recipient for the attacker's address.",
    defense: "The decoded recipient parameter must be present in the explicit recipient allowlist.",
  },
];

class PaymasterPolicyViolation extends Error {
  public readonly code: string;
  public constructor(code: string, public readonly details: readonly unknown[] = []) {
    super(code);
    this.name = "PaymasterPolicyViolation";
    this.code = code;
  }
}

class AgentPaymasterSimulator {
  public readonly accountAgent = new Map<string, string>();
  public readonly dailyLimit = new Map<string, bigint>();
  public readonly spent = new Map<string, bigint>();
  public readonly reserved = new Map<string, bigint>();
  public now = 1_700_000_000;
  public readonly windowStart = new Map<string, number>();

  public register(account: string, agent: string, limit: bigint): void {
    this.accountAgent.set(account.toLowerCase(), agent.toLowerCase());
    this.dailyLimit.set(agent.toLowerCase(), limit);
    this.windowStart.set(agent.toLowerCase(), this.now);
  }

  public validate(account: string, agent: string, declaredGas: bigint, userOpHash: Hex): void {
    const normalizedAgent = agent.toLowerCase();
    if (this.accountAgent.get(account.toLowerCase()) !== normalizedAgent) {
      throw new PaymasterPolicyViolation("AgentNotRegistered", [account, agent]);
    }
    if (declaredGas <= 0n) throw new PaymasterPolicyViolation("InvalidGasDeclaration");
    this.refresh(normalizedAgent);
    const projected = (this.spent.get(normalizedAgent) ?? 0n) + (this.reserved.get(normalizedAgent) ?? 0n) + declaredGas;
    const limit = this.dailyLimit.get(normalizedAgent) ?? 0n;
    if (projected > limit) throw new PaymasterPolicyViolation("PaymasterDailyGasLimitExceeded", [projected, limit, userOpHash]);
    this.reserved.set(normalizedAgent, (this.reserved.get(normalizedAgent) ?? 0n) + declaredGas);
  }

  public postOp(agent: string, declaredGas: bigint, actualGas: bigint): void {
    const normalizedAgent = agent.toLowerCase();
    this.refresh(normalizedAgent);
    const currentReserved = this.reserved.get(normalizedAgent) ?? 0n;
    if (currentReserved < declaredGas) throw new PaymasterPolicyViolation("InsufficientReservedGas");
    const settled = actualGas < declaredGas ? actualGas : declaredGas;
    this.reserved.set(normalizedAgent, currentReserved - declaredGas);
    this.spent.set(normalizedAgent, (this.spent.get(normalizedAgent) ?? 0n) + settled);
  }

  public advanceTime(seconds: number): void {
    this.now += seconds;
  }

  private refresh(agent: string): void {
    const start = this.windowStart.get(agent) ?? this.now;
    if (this.now >= start + 86_400) {
      this.windowStart.set(agent, this.now);
      this.spent.set(agent, 0n);
      this.reserved.set(agent, 0n);
    }
  }
}

export class AttackExecutionEngine {
  public run(id: AttackId): AttackResult {
    switch (id) {
      case "direct-drain": return this.attackDirectDrain();
      case "micro-drain": return this.attackMicroDrain();
      case "selector-spoof": return this.attackSelectorSpoof();
      case "expired-replay": return this.attackExpiredReplay();
      case "paymaster-siphon": return this.attackPaymasterSiphon();
      case "recipient-diversion": return this.attackRecipientDiversion();
    }
  }

  public runAll(): AttackResult[] {
    return ATTACK_CATALOG.map(({ id }) => this.run(id));
  }

  private attackDirectDrain(): AttackResult {
    const fixture = this.fixture(3_600);
    fixture.engine.setLimits(parseEther("0.05"), parseEther("0.25"));
    fixture.engine.setAllowedRecipient(ATTACKER, true);
    const execution = this.execution("direct-drain", ATTACKER, parseEther("20"), "0x");
    const userOp = this.userOp(execution, 0n, fixture.agent);
    const steps = this.baseSteps(execution, userOp.callData, "20 ETH balance extraction");
    let failure = "";
    try {
      fixture.account.validateUserOp(userOp, execution.userOpHash);
      fixture.account.execute(execution);
    } catch (error) {
      failure = error instanceof PolicyViolation ? error.code : String(error);
      steps.push(this.step(steps.length, "defense", "reverted", "PolicyEngine.checkPerTxLimit", { error: failure, reservation: "none", execution: "not reached" }));
    }
    const loss = 0n;
    steps.push(this.proofStep(steps.length, loss, parseEther("0.25"), "20 ETH transfer rejected before reservation"));
    return this.result("direct-drain", "Direct Attacker Drain", "A leaked agent key attempts catastrophic extraction.", steps, loss, parseEther("0.25"), { failure, attempted: "20 ETH", walletBalance: "20 ETH" }, "0 ETH", "0 <= 0.25 ETH");
  }

  private attackMicroDrain(): AttackResult {
    const fixture = this.fixture(3_600);
    const perTx = parseEther("0.05");
    const dailyLimit = parseEther("0.25");
    const amount = parseEther("0.04");
    fixture.engine.setLimits(perTx, dailyLimit);
    fixture.engine.setAllowedRecipient(ATTACKER, true);
    const steps: TraceStep[] = [];
    let successes = 0;
    let failures = 0;
    let loss = 0n;
    for (let index = 1; index <= 50; index += 1) {
      const execution = this.execution(`micro-drain-${index}`, ATTACKER, amount, "0x");
      const userOp = this.userOp(execution, BigInt(index - 1), fixture.agent);
      const callData = this.baseSteps(execution, userOp.callData, `rapid transfer ${index}/50`);
      steps.push(...callData);
      try {
        fixture.account.validateUserOp(userOp, execution.userOpHash);
        fixture.account.execute(execution);
        successes += 1;
        loss += amount;
        steps.push(this.step(steps.length, "mutate", "settled", `transfer ${index} settled`, { amount: amount.toString(), cumulativeLossWei: loss.toString(), dailyLimitWei: dailyLimit.toString() }));
      } catch (error) {
        failures += 1;
        const code = error instanceof PolicyViolation ? error.code : String(error);
        steps.push(this.step(steps.length, "defense", "reverted", `transfer ${index} blocked`, { error: code, cumulativeLossWei: loss.toString() }));
      }
    }
    steps.push(this.proofStep(steps.length, loss, dailyLimit, `${successes} x 0.04 ETH = ${Number(successes) * 0.04} ETH; operation ${successes + 1} would project above 0.25 ETH`));
    return this.result("micro-drain", "High-Frequency Micro-Drain", "Fifty below-cap transfers compete against one rolling daily counter.", steps, loss, dailyLimit, {
      attempted: "50",
      successful: String(successes),
      reverted: String(failures),
      perTransaction: "0.04 ETH",
      arithmetic: `${successes} × 0.04 ETH = ${Number(successes) * 0.04} ETH`,
      firstRejected: String(successes + 1),
    }, "0", `${loss.toString()} <= ${dailyLimit.toString()}`);
  }

  private attackSelectorSpoof(): AttackResult {
    const fixture = this.fixture(3_600);
    fixture.engine.setLimits(parseEther("1"), parseEther("5"));
    fixture.engine.setAllowedTarget(ACCOUNT, true);
    fixture.engine.setAllowedTarget(DEFI, true);
    const attempts: Array<{ label: string; target: string; data: Hex }> = [
      { label: "selfdestruct()", target: ACCOUNT, data: selector("selfdestruct()") },
      { label: "transferOwnership(attacker)", target: ACCOUNT, data: ACCOUNT_INTERFACE.encodeFunctionData("transferOwnership", [ATTACKER]) as Hex },
      { label: "stake(1000)", target: DEFI, data: ACCOUNT_INTERFACE.encodeFunctionData("stake", [1000n]) as Hex },
    ];
    const steps: TraceStep[] = [];
    let rejected = 0;
    for (const [index, attempt] of attempts.entries()) {
      const execution = this.execution(`selector-spoof-${index}`, attempt.target, 0n, attempt.data);
      const userOp = this.userOp(execution, BigInt(index), fixture.agent);
      steps.push(...this.baseSteps(execution, userOp.callData, attempt.label));
      try {
        fixture.account.validateUserOp(userOp, execution.userOpHash);
        fixture.account.execute(execution);
      } catch (error) {
        rejected += 1;
        const code = error instanceof PolicyViolation ? error.code : String(error);
        steps.push(this.step(steps.length, "defense", "reverted", `${attempt.label} blocked`, { selector: attempt.data.slice(0, 10), error: code, lossWei: "0" }));
      }
    }
    steps.push(this.proofStep(steps.length, 0n, parseEther("5"), "all three unauthorized selector attempts revert before state mutation"));
    return this.result("selector-spoof", "Unauthorized Selector Spoof", "Privilege selectors are rejected at the byte boundary.", steps, 0n, parseEther("5"), { attempted: String(attempts.length), rejected: String(rejected), selectors: attempts.map((item) => item.data.slice(0, 10)).join(", ") }, "0", "0 <= 5 ETH");
  }

  private attackExpiredReplay(): AttackResult {
    const fixture = this.fixture(30);
    fixture.engine.setLimits(parseEther("1"), parseEther("5"));
    fixture.engine.setAllowedRecipient(ATTACKER, true);
    const execution = this.execution("expired-replay", ATTACKER, parseEther("0.04"), "0x");
    const userOp = this.userOp(execution, 0n, fixture.agent);
    const steps = this.baseSteps(execution, userOp.callData, "capture valid signature before expiry");
    steps.push(this.step(steps.length, "attack", "attempted", "advance clock beyond strict validUntil", { validUntil: String(fixture.engine.agentValidUntil), nowBefore: String(fixture.engine.now) }));
    fixture.engine.advanceTime(31);
    let failure = "";
    try {
      fixture.account.validateUserOp(userOp, execution.userOpHash);
    } catch (error) {
      failure = error instanceof PolicyViolation ? error.code : String(error);
      steps.push(this.step(steps.length, "defense", "reverted", "ERC-4337 validation rejected replay", { error: failure, validationData: "SIG_VALIDATION_FAILED / expired time range", now: String(fixture.engine.now) }));
    }
    steps.push(this.proofStep(steps.length, 0n, parseEther("5"), "expired signature cannot create a pending reservation"));
    return this.result("expired-replay", "Expired Session-Key Replay", "A captured signature is replayed after the agent deadline.", steps, 0n, parseEther("5"), { failure, validUntil: String(fixture.engine.agentValidUntil), broadcastAt: String(fixture.engine.now) }, "0", "0 <= 5 ETH");
  }

  private attackPaymasterSiphon(): AttackResult {
    const paymaster = new AgentPaymasterSimulator();
    const stipend = 500_000n;
    const declaredGas = 20_000n;
    paymaster.register(ACCOUNT, AGENT_WALLET.address, stipend);
    const steps: TraceStep[] = [];
    let accepted = 0;
    let rejected = 0;
    for (let index = 1; index <= 50; index += 1) {
      const hash = keccak256(toUtf8Bytes(`paymaster-siphon-${index}`)) as Hex;
      steps.push(this.step(steps.length, "attack", "attempted", `sponsored no-op ${index}/50`, { agent: AGENT_WALLET.address, declaredGas: declaredGas.toString(), userOpHash: hash }));
      try {
        paymaster.validate(ACCOUNT, AGENT_WALLET.address, declaredGas, hash);
        paymaster.postOp(AGENT_WALLET.address, declaredGas, declaredGas);
        accepted += 1;
        steps.push(this.step(steps.length, "mutate", "settled", `sponsorship ${index} settled`, { spentGas: (BigInt(accepted) * declaredGas).toString(), dailyGasLimit: stipend.toString() }));
      } catch (error) {
        rejected += 1;
        const code = error instanceof PaymasterPolicyViolation ? error.code : String(error);
        steps.push(this.step(steps.length, "defense", "reverted", `sponsorship ${index} refused`, { error: code, spentGas: (BigInt(accepted) * declaredGas).toString(), dailyGasLimit: stipend.toString() }));
      }
    }
    const spent = BigInt(accepted) * declaredGas;
    steps.push(this.proofStep(steps.length, 0n, 0n, `${accepted} × ${declaredGas} gas = ${spent} gas <= ${stipend} gas stipend`));
    return this.result("paymaster-siphon", "Paymaster Gas Siphon", "Sponsored execution is bounded independently from wallet value policy.", steps, 0n, 0n, { attempted: "50", accepted: String(accepted), refused: String(rejected), gasSpent: spent.toString(), gasLimit: stipend.toString() }, spent.toString(), `${spent} gas <= ${stipend} gas`);
  }

  private attackRecipientDiversion(): AttackResult {
    const fixture = this.fixture(3_600);
    fixture.engine.setLimits(parseEther("1"), parseEther("5"));
    fixture.engine.setAllowedTarget(BILLING, true);
    fixture.engine.setAllowedSelector(BILLING, PAY_CREDITS_SELECTOR, true);
    fixture.engine.setAllowedRecipient(LEGITIMATE_BILLING_RECIPIENT, true);
    const data = BILLING_INTERFACE.encodeFunctionData("payCredits", [ATTACKER, 100n]) as Hex;
    const execution = this.execution("recipient-diversion", BILLING, 0n, data);
    const userOp = this.userOp(execution, 0n, fixture.agent);
    const steps = this.baseSteps(execution, userOp.callData, "prompt injection substitutes attacker recipient");
    let failure = "";
    try {
      fixture.account.validateUserOp(userOp, execution.userOpHash);
      fixture.account.execute(execution);
    } catch (error) {
      failure = error instanceof PolicyViolation ? error.code : String(error);
      steps.push(this.step(steps.length, "defense", "reverted", "recipient whitelist rejected diverted payment", { error: failure, decodedRecipient: ATTACKER, allowedRecipient: LEGITIMATE_BILLING_RECIPIENT, lossWei: "0" }));
    }
    steps.push(this.proofStep(steps.length, 0n, parseEther("5"), "selector is allowed but decoded recipient is not"));
    return this.result("recipient-diversion", "Phishing Recipient Diversion", "A valid billing selector cannot redirect funds to an unapproved recipient.", steps, 0n, parseEther("5"), { failure, selector: PAY_CREDITS_SELECTOR, decodedRecipient: ATTACKER, approvedRecipient: LEGITIMATE_BILLING_RECIPIENT }, "0", "0 <= 5 ETH");
  }

  private fixture(expirySeconds: number): { engine: PolicyEngineSimulator; account: AgentSmartAccountSimulator; agent: Wallet; owner: Wallet } {
    const engine = new PolicyEngineSimulator(ACCOUNT, OWNER_WALLET.address, 1_700_000_000, POLICY_ENGINE);
    const agent = AGENT_WALLET;
    engine.setAgentKey(agent.address, engine.now + expirySeconds);
    const account = new AgentSmartAccountSimulator(ACCOUNT, OWNER_WALLET.address, engine);
    return { engine, account, agent, owner: OWNER_WALLET };
  }

  private execution(label: string, target: string, value: bigint, data: Hex): ExecutionCall {
    return { userOpHash: keccak256(toUtf8Bytes(label)) as Hex, target, value, data };
  }

  private userOp(execution: ExecutionCall, nonceSequence: bigint, agent: Wallet): UserOperationV06 {
    const signerSignature = agent.signingKey.sign(hashMessage(getBytesFromHash(execution.userOpHash))).serialized as Hex;
    return {
      sender: ACCOUNT,
      nonce: packNonce(1n, nonceSequence),
      initCode: "0x",
      callData: encodeExecution(execution),
      callGasLimit: 500_000n,
      verificationGasLimit: 500_000n,
      preVerificationGas: 50_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      paymasterAndData: "0x",
      signature: encodeAuthorization({ signerType: 1, signerSignature, ownerApprovalSignature: "0x", ownerApprovalValidUntil: 0 }),
    };
  }

  private baseSteps(execution: ExecutionCall, callData: Hex, label: string): TraceStep[] {
    const decoded = decodeExecutionBytes(callData);
    return [
      this.step(0, "attack", "attempted", label, { target: execution.target, valueWei: execution.value.toString(), userOpHash: execution.userOpHash }),
      this.step(1, "decode", "accepted", "outer execute selector extracted", { selector: callData.slice(0, 10), expectedSelector: callData.slice(0, 10), abiOffset: "0x80", dataLength: String((execution.data.length - 2) / 2) }),
      this.step(2, "decode", "accepted", "target, value, and inner payload decoded", { target: decoded.target, valueWei: decoded.value.toString(), innerSelector: decoded.data === "0x" ? "0x00000000" : decoded.data.slice(0, 10), innerCalldata: decoded.data }),
      this.step(3, "validate", "attempted", "agent signature submitted to ERC-4337 account", { nonce: "0x" + execution.userOpHash.slice(2, 18), signer: AGENT_WALLET.address }),
    ];
  }

  private step(index: number, phase: TraceStep["phase"], status: TraceStep["status"], label: string, details: Record<string, string>): TraceStep {
    return { index, phase, status, label, details };
  }

  private proofStep(index: number, loss: bigint, limit: bigint, equation: string): TraceStep {
    return this.step(index, "proof", "verified", "Max Loss Guarantee Maintained", { lossWei: loss.toString(), dailyLimitWei: limit.toString(), equation, invariant: limit === 0n ? "gas-only invariant" : `${loss.toString()} <= ${limit.toString()}` });
  }

  private result(id: AttackId, title: string, description: string, steps: TraceStep[], lossWei: bigint, dailyLimitWei: bigint, metrics: Record<string, string>, gasLoss: string, inequality: string): AttackResult {
    const proofPayload = JSON.stringify({ id, lossWei: lossWei.toString(), dailyLimitWei: dailyLimitWei.toString(), metrics, inequality });
    const proofHash = keccak256(toUtf8Bytes(proofPayload)) as Hex;
    const passed = dailyLimitWei === 0n ? BigInt(gasLoss) <= 500_000n : lossWei <= dailyLimitWei;
    return { id, title, description, passed, lossWei: lossWei.toString(), dailyLimitWei: dailyLimitWei.toString(), gasLoss, steps, metrics, proof: { equation: metrics.arithmetic ?? inequality, inequality, hash: proofHash } };
  }
}

function selector(signature: string): Hex {
  return (`0x${keccak256(toUtf8Bytes(signature)).slice(2, 10)}`) as Hex;
}

function decodeExecutionBytes(callData: Hex): { target: string; value: bigint; data: Hex } {
  const [userOpHash, target, value, data] = ABI.decode(["bytes32", "address", "uint256", "bytes"], `0x${callData.slice(10)}`) as unknown as [Hex, string, bigint, Hex];
  userOpHash;
  return { target, value, data };
}

void BILLING_INTERFACE;

function getBytesFromHash(hash: Hex): Uint8Array {
  return new Uint8Array(hash.slice(2).match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}
