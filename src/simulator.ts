import {
  AbiCoder,
  concat,
  getBytes,
  hashMessage,
  keccak256,
  recoverAddress,
  toBeHex,
} from "ethers";
import type {
  AuthorizationEnvelope,
  ExecutionCall,
  ExecutionResult,
  Hex,
  PendingApprovalRecord,
  PolicyLimits,
  PolicyValidationInput,
  UserOperationV06,
  PackedUserOperationV07,
} from "./types.js";

export const EXECUTE_SELECTOR = "0x" + keccak256(new TextEncoder().encode("execute(bytes32,address,uint256,bytes)")).slice(2, 10) as Hex;
export const ERC20_TRANSFER_SELECTOR = "0x" + keccak256(new TextEncoder().encode("transfer(address,uint256)")).slice(2, 10) as Hex;
export const ERC20_APPROVE_SELECTOR = "0x" + keccak256(new TextEncoder().encode("approve(address,uint256)")).slice(2, 10) as Hex;
export const ERC20_TRANSFER_FROM_SELECTOR = "0x" + keccak256(new TextEncoder().encode("transferFrom(address,address,uint256)")).slice(2, 10) as Hex;
export const PAY_CREDITS_SELECTOR = "0x" + keccak256(new TextEncoder().encode("payCredits(address,uint256)")).slice(2, 10) as Hex;

const ABI = AbiCoder.defaultAbiCoder();
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const WINDOW_SIZE = 86_400;
const OWNER_APPROVAL_TYPES = {
  OwnerApproval: [
    { name: "userOpHash", type: "bytes32" },
    { name: "target", type: "address" },
    { name: "nativeValue", type: "uint256" },
    { name: "tokenAmount", type: "uint256" },
    { name: "callDataHash", type: "bytes32" },
    { name: "validUntil", type: "uint48" },
  ],
};

export class PolicyViolation extends Error {
  public readonly code: string;
  public readonly details: readonly unknown[];

  public constructor(code: string, ...details: unknown[]) {
    super(code);
    this.name = "PolicyViolation";
    this.code = code;
    this.details = details;
  }
}

export class PolicyEngineSimulator {
  public readonly account: string;
  public readonly policyEngineAddress: string;
  public owner: string;
  public agentKey: string = ZERO_ADDRESS;
  public agentValidUntil = 0;
  public agentRevoked = false;
  public limits: PolicyLimits = {
    maxPerTxValueWei: 0n,
    dailyLimitWei: 0n,
    requiresOwnerApproval: false,
    ownerApprovalThresholdWei: 0n,
  };
  public spentTodayWei = 0n;
  public reservedTodayWei = 0n;
  public now: number;
  public windowStartTimestamp: number;
  public readonly allowedTargets = new Set<string>();
  public readonly allowedSelectors = new Map<string, Set<Hex>>();
  public readonly allowedRecipients = new Set<string>();
  public readonly spentTodayTokenUnits = new Map<string, bigint>();
  public readonly reservedTodayTokenUnits = new Map<string, bigint>();
  public readonly pendingApprovals = new Map<Hex, PendingApprovalRecord>();
  public readonly ownerAuthorizedUserOps = new Set<Hex>();

  public constructor(account: string, owner: string, now = 1_700_000_000, policyEngineAddress = account) {
    this.account = account.toLowerCase();
    this.policyEngineAddress = policyEngineAddress.toLowerCase();
    this.owner = owner.toLowerCase();
    this.now = now;
    this.windowStartTimestamp = now;
  }

  public setAgentKey(agentKey: string, validUntil: number): void {
    if (agentKey.toLowerCase() === ZERO_ADDRESS) throw new PolicyViolation("InvalidAgentKey");
    if (validUntil <= this.now) throw new PolicyViolation("InvalidAgentExpiry");
    this.agentKey = agentKey.toLowerCase();
    this.agentValidUntil = validUntil;
    this.agentRevoked = false;
  }

  public revokeAgentKey(): void {
    this.agentRevoked = true;
  }

  public setLimits(maxPerTxValueWei: bigint, dailyLimitWei: bigint): void {
    this.limits.maxPerTxValueWei = maxPerTxValueWei;
    this.limits.dailyLimitWei = dailyLimitWei;
  }

  public setOwnerApprovalPolicy(required: boolean, threshold: bigint): void {
    this.limits.requiresOwnerApproval = required;
    this.limits.ownerApprovalThresholdWei = threshold;
  }

  public setAllowedTarget(target: string, allowed: boolean): void {
    this.setCaseInsensitive(this.allowedTargets, target, allowed);
  }

  public setAllowedSelector(target: string, selector: Hex, allowed: boolean): void {
    const key = target.toLowerCase();
    const set = this.allowedSelectors.get(key) ?? new Set<Hex>();
    if (allowed) set.add(selector.toLowerCase() as Hex);
    else set.delete(selector.toLowerCase() as Hex);
    this.allowedSelectors.set(key, set);
  }

  public setAllowedRecipient(recipient: string, allowed: boolean): void {
    this.setCaseInsensitive(this.allowedRecipients, recipient, allowed);
  }

  public advanceTime(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < 0) throw new Error("invalid time delta");
    this.now += seconds;
  }

  public ownerApprovalDigest(input: PolicyValidationInput, validUntil = input.ownerApprovalValidUntil): Hex {
    const domain = {
      name: "AgentWallet Policy",
      version: "1",
      chainId: 1,
      verifyingContract: this.policyEngineAddress,
    };
    const struct = {
      userOpHash: input.userOpHash,
      target: input.target,
      nativeValue: input.nativeValue,
      tokenAmount: input.tokenAmount,
      callDataHash: input.callDataHash,
      validUntil,
    };
    // The Solidity engine uses the policy-engine address as verifyingContract. The
    // simulator's account address is its stable stand-in for that deployed address.
    return TypedDataHash(domain, OWNER_APPROVAL_TYPES, struct);
  }

  public validateUserOpPolicy(input: PolicyValidationInput): number {
    this.refreshWindow();
    if (this.agentRevoked || this.agentKey === ZERO_ADDRESS || this.now >= this.agentValidUntil) {
      throw new PolicyViolation("PolicyViolation_ExpiredKey", this.agentValidUntil, this.now);
    }
    if (input.nativeValue !== 0n && input.tokenAmount !== 0n) {
      throw new PolicyViolation("PolicyViolation_MixedValueTransfer");
    }
    const tokenOperation = input.tokenAmount !== 0n;
    const amount = tokenOperation ? input.tokenAmount : input.nativeValue;
    if (this.limits.maxPerTxValueWei !== 0n && amount > this.limits.maxPerTxValueWei) {
      throw new PolicyViolation("PolicyViolation_PerTxLimitExceeded", amount, this.limits.maxPerTxValueWei);
    }
    if (input.recipient !== ZERO_ADDRESS && !this.allowedRecipients.has(input.recipient.toLowerCase())) {
      throw new PolicyViolation("PolicyViolation_RecipientNotAllowed", input.recipient);
    }
    const target = input.target.toLowerCase();
    const selector = input.selector.toLowerCase() as Hex;
    if (input.nativeValue !== 0n && selector === "0x00000000") {
      if (!this.allowedRecipients.has(target)) throw new PolicyViolation("PolicyViolation_RecipientNotAllowed", target);
    } else {
      if (!this.allowedTargets.has(target)) throw new PolicyViolation("PolicyViolation_TargetNotAllowed", target);
      if (!this.allowedSelectors.get(target)?.has(selector)) {
        throw new PolicyViolation("PolicyViolation_SelectorNotAllowed", target, selector);
      }
    }
    const spent = tokenOperation ? this.spentTodayTokenUnits.get(target) ?? 0n : this.spentTodayWei;
    const reserved = tokenOperation ? this.reservedTodayTokenUnits.get(target) ?? 0n : this.reservedTodayWei;
    const exceedsDaily = this.limits.dailyLimitWei !== 0n && spent + reserved + amount > this.limits.dailyLimitWei;
    const approvalRequired = this.limits.requiresOwnerApproval && amount > this.limits.ownerApprovalThresholdWei || exceedsDaily;
    if (exceedsDaily && !this.limits.requiresOwnerApproval) {
      throw new PolicyViolation("PolicyViolation_DailyLimitExceeded", spent + reserved + amount, this.limits.dailyLimitWei);
    }
    if (approvalRequired) {
      if (input.ownerApprovalSignature === "0x") throw new PolicyViolation("OwnerApprovalRequired", input.userOpHash, amount);
      if (input.ownerApprovalValidUntil === 0 || this.now >= input.ownerApprovalValidUntil) {
        throw new PolicyViolation("OwnerApprovalExpired", input.ownerApprovalValidUntil, this.now);
      }
      if (input.ownerApprovalValidUntil > this.agentValidUntil) {
        throw new PolicyViolation("ApprovalDeadlineAfterAgentExpiry");
      }
      const recovered = recoverAddress(this.ownerApprovalDigest(input), input.ownerApprovalSignature).toLowerCase();
      if (recovered !== this.owner) throw new PolicyViolation("InvalidOwnerApproval", recovered, this.owner);
    }
    if (this.pendingApprovals.has(input.userOpHash)) throw new PolicyViolation("PendingApprovalAlreadyExists");
    this.pendingApprovals.set(input.userOpHash, {
      target,
      selector,
      callDataHash: input.callDataHash,
      amount,
      agentValidUntil: this.agentValidUntil,
      tokenOperation,
      ownerApprovalRequired: approvalRequired,
      consumed: false,
    });
    if (tokenOperation) this.reservedTodayTokenUnits.set(target, reserved + amount);
    else this.reservedTodayWei += amount;
    return this.agentValidUntil;
  }

  public consumePendingApproval(
    userOpHash: Hex,
    target: string,
    selector: Hex,
    nativeValue: bigint,
    tokenAmount: bigint,
    callDataHash: Hex,
  ): void {
    this.refreshWindow();
    const pending = this.pendingApprovals.get(userOpHash);
    if (!pending) throw new PolicyViolation("PendingApprovalNotFound", userOpHash);
    if (pending.consumed) throw new PolicyViolation("PendingApprovalConsumed", userOpHash);
    const amount = tokenAmount !== 0n ? tokenAmount : nativeValue;
    if (pending.target !== target.toLowerCase() || pending.selector !== selector.toLowerCase() || pending.callDataHash !== callDataHash || pending.amount !== amount || pending.tokenOperation !== (tokenAmount !== 0n)) {
      throw new PolicyViolation("PendingApprovalMismatch");
    }
    pending.consumed = true;
    if (pending.tokenOperation) {
      this.reservedTodayTokenUnits.set(pending.target, (this.reservedTodayTokenUnits.get(pending.target) ?? 0n) - pending.amount);
      this.spentTodayTokenUnits.set(pending.target, (this.spentTodayTokenUnits.get(pending.target) ?? 0n) + pending.amount);
    } else {
      this.reservedTodayWei -= pending.amount;
      this.spentTodayWei += pending.amount;
    }
  }

  public currentNativeSpend(): bigint {
    if (this.now >= this.windowStartTimestamp + WINDOW_SIZE) return 0n;
    return this.spentTodayWei + this.reservedTodayWei;
  }

  private refreshWindow(): void {
    if (this.now >= this.windowStartTimestamp + WINDOW_SIZE) {
      this.windowStartTimestamp = this.now;
      this.spentTodayWei = 0n;
      this.reservedTodayWei = 0n;
      this.spentTodayTokenUnits.clear();
      this.reservedTodayTokenUnits.clear();
    }
  }

  private setCaseInsensitive(set: Set<string>, value: string, allowed: boolean): void {
    const key = value.toLowerCase();
    if (allowed) set.add(key);
    else set.delete(key);
  }
}

export class AgentSmartAccountSimulator {
  public readonly policyEngine: PolicyEngineSimulator;
  public owner: string;
  public readonly address: string;
  public readonly nextSequence = new Map<bigint, bigint>();

  public constructor(address: string, owner: string, policyEngine: PolicyEngineSimulator) {
    this.address = address.toLowerCase();
    this.owner = owner.toLowerCase();
    this.policyEngine = policyEngine;
  }

  public validateUserOp(
    userOp: UserOperationV06 | PackedUserOperationV07,
    userOpHash: Hex,
  ): number {
    const snapshot = this.snapshot();
    try {
      const execution = decodeExecution(userOp.callData);
      if (userOp.sender.toLowerCase() !== this.address) throw new PolicyViolation("InvalidSender", userOp.sender);
      if (execution.userOpHash.toLowerCase() !== userOpHash.toLowerCase()) throw new PolicyViolation("PolicyViolation_MalformedCalldata");
      const nonceKey = userOp.nonce >> 64n;
      const sequence = userOp.nonce & ((1n << 64n) - 1n);
      const expected = this.nextSequence.get(nonceKey) ?? 0n;
      if (sequence !== expected) throw new PolicyViolation("InvalidNonce", nonceKey, expected, sequence);
      if (expected === (1n << 64n) - 1n) throw new PolicyViolation("NonceOverflow", nonceKey);
      this.nextSequence.set(nonceKey, expected + 1n);
      const authorization = decodeAuthorization(userOp.signature);
      if (authorization.signerType === 0) {
        if (recoverAddress(hashMessage(getBytes(userOpHash)), authorization.signerSignature).toLowerCase() !== this.owner) {
          throw new PolicyViolation("InvalidAuthorization");
        }
        this.policyEngine.ownerAuthorizedUserOps.add(userOpHash);
        return 0;
      }
      if (authorization.signerType !== 1) throw new PolicyViolation("InvalidSignerType", authorization.signerType);
      if (recoverAddress(hashMessage(getBytes(userOpHash)), authorization.signerSignature).toLowerCase() !== this.policyEngine.agentKey) {
        throw new PolicyViolation("InvalidAuthorization");
      }
      const parsed = parseInnerCall(execution.data);
      return this.policyEngine.validateUserOpPolicy({
        userOpHash,
        target: execution.target,
        nativeValue: execution.value,
        selector: parsed.selector,
        recipient: parsed.recipient,
        tokenAmount: parsed.tokenAmount,
        callDataHash: keccak256(execution.data) as Hex,
        ownerApprovalSignature: authorization.ownerApprovalSignature,
        ownerApprovalValidUntil: authorization.ownerApprovalValidUntil,
      });
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  public execute(execution: ExecutionCall): ExecutionResult {
    const parsed = parseInnerCall(execution.data);
    if (this.policyEngine.ownerAuthorizedUserOps.has(execution.userOpHash)) {
      this.policyEngine.ownerAuthorizedUserOps.delete(execution.userOpHash);
    } else {
      this.policyEngine.consumePendingApproval(
        execution.userOpHash,
        execution.target,
        parsed.selector,
        execution.value,
        parsed.tokenAmount,
        keccak256(execution.data) as Hex,
      );
    }
    return { ...execution, tokenAmount: parsed.tokenAmount, selector: parsed.selector };
  }

  private snapshot(): { nextSequence: Map<bigint, bigint>; pending: Map<Hex, PendingApprovalRecord>; ownerAuthorized: Set<Hex>; spent: bigint; reserved: bigint } {
    return {
      nextSequence: new Map(this.nextSequence),
      pending: new Map([...this.policyEngine.pendingApprovals.entries()].map(([key, value]) => [key, { ...value }])),
      ownerAuthorized: new Set(this.policyEngine.ownerAuthorizedUserOps),
      spent: this.policyEngine.spentTodayWei,
      reserved: this.policyEngine.reservedTodayWei,
    };
  }

  private restore(snapshot: { nextSequence: Map<bigint, bigint>; pending: Map<Hex, PendingApprovalRecord>; ownerAuthorized: Set<Hex>; spent: bigint; reserved: bigint }): void {
    this.nextSequence.clear();
    for (const [key, value] of snapshot.nextSequence) this.nextSequence.set(key, value);
    this.policyEngine.pendingApprovals.clear();
    for (const [key, value] of snapshot.pending) this.policyEngine.pendingApprovals.set(key, value);
    this.policyEngine.ownerAuthorizedUserOps.clear();
    for (const key of snapshot.ownerAuthorized) this.policyEngine.ownerAuthorizedUserOps.add(key);
    this.policyEngine.spentTodayWei = snapshot.spent;
    this.policyEngine.reservedTodayWei = snapshot.reserved;
  }
}

export function encodeExecution(execution: ExecutionCall): Hex {
  return concat([
    EXECUTE_SELECTOR,
    ABI.encode(["bytes32", "address", "uint256", "bytes"], [execution.userOpHash, execution.target, execution.value, execution.data]),
  ]) as Hex;
}

export function encodeAuthorization(authorization: AuthorizationEnvelope): Hex {
  return ABI.encode(
    ["uint8", "bytes", "bytes", "uint48"],
    [authorization.signerType, authorization.signerSignature, authorization.ownerApprovalSignature, authorization.ownerApprovalValidUntil],
  ) as Hex;
}

function decodeExecution(callData: Hex): ExecutionCall {
  if (callData.length < 10 || callData.slice(0, 10).toLowerCase() !== EXECUTE_SELECTOR) throw new PolicyViolation("InvalidExecutionSelector");
  try {
    const [userOpHash, target, value, data] = ABI.decode(["bytes32", "address", "uint256", "bytes"], `0x${callData.slice(10)}`) as unknown as [Hex, string, bigint, Hex];
    return { userOpHash, target, value, data };
  } catch {
    throw new PolicyViolation("PolicyViolation_MalformedCalldata");
  }
}

function decodeAuthorization(signature: Hex): AuthorizationEnvelope {
  try {
    const [signerType, signerSignature, ownerApprovalSignature, ownerApprovalValidUntil] = ABI.decode(
      ["uint8", "bytes", "bytes", "uint48"],
      signature,
    ) as unknown as [bigint, Hex, Hex, bigint];
    return {
      signerType: Number(signerType) as 0 | 1,
      signerSignature,
      ownerApprovalSignature,
      ownerApprovalValidUntil: Number(ownerApprovalValidUntil),
    };
  } catch {
    throw new PolicyViolation("InvalidAuthorization");
  }
}

function parseInnerCall(data: Hex): { selector: Hex; recipient: string; tokenAmount: bigint } {
  if (data === "0x") return { selector: "0x00000000", recipient: ZERO_ADDRESS, tokenAmount: 0n };
  if (data.length < 10) throw new PolicyViolation("PolicyViolation_MalformedCalldata");
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  const args = `0x${data.slice(10)}`;
  try {
    if (selector === ERC20_TRANSFER_SELECTOR || selector === ERC20_APPROVE_SELECTOR) {
      const [recipient, amount] = ABI.decode(["address", "uint256"], args) as unknown as [string, bigint];
      return { selector, recipient, tokenAmount: amount };
    }
    if (selector === ERC20_TRANSFER_FROM_SELECTOR) {
      const [, recipient, amount] = ABI.decode(["address", "address", "uint256"], args) as unknown as [string, string, bigint];
      return { selector, recipient, tokenAmount: amount };
    }
    if (selector === PAY_CREDITS_SELECTOR) {
      const [recipient, amount] = ABI.decode(["address", "uint256"], args) as unknown as [string, bigint];
      return { selector, recipient, tokenAmount: amount };
    }
    return { selector, recipient: ZERO_ADDRESS, tokenAmount: 0n };
  } catch {
    throw new PolicyViolation("PolicyViolation_MalformedCalldata");
  }
}

function TypedDataHash(domain: Record<string, unknown>, _types: Record<string, Array<{ name: string; type: string }>>, value: Record<string, unknown>): Hex {
  const domainHash = keccak256(ABI.encode(["bytes32", "bytes32", "bytes32", "uint256", "address"], [
    keccak256(new TextEncoder().encode("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
    keccak256(new TextEncoder().encode(String(domain.name))),
    keccak256(new TextEncoder().encode(String(domain.version))),
    domain.chainId,
    domain.verifyingContract,
  ]));
  const structHash = keccak256(ABI.encode(["bytes32", "bytes32", "address", "uint256", "uint256", "bytes32", "uint48"], [
    keccak256(new TextEncoder().encode("OwnerApproval(bytes32 userOpHash,address target,uint256 nativeValue,uint256 tokenAmount,bytes32 callDataHash,uint48 validUntil)")),
    value.userOpHash,
    value.target,
    value.nativeValue,
    value.tokenAmount,
    value.callDataHash,
    value.validUntil,
  ]));
  return keccak256(concat(["0x1901", domainHash, structHash])) as Hex;
}

export function packNonce(key: bigint, sequence: bigint): bigint {
  if (key < 0n || key >= 1n << 192n || sequence < 0n || sequence >= 1n << 64n) throw new Error("nonce component out of range");
  return (key << 64n) | sequence;
}

export function uintToHex(value: bigint, bytes = 32): Hex {
  return toBeHex(value, bytes) as Hex;
}

export function zeroAddress(): string {
  return ZERO_ADDRESS;
}
