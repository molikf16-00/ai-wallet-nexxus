import type { BytesLike } from "ethers";

export type Hex = `0x${string}`;

export interface UserOperationV06 {
  sender: string;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: Hex;
  signature: Hex;
}

export interface PackedUserOperationV07 {
  sender: string;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

export interface ExecutionCall {
  userOpHash: Hex;
  target: string;
  value: bigint;
  data: Hex;
}

export interface AuthorizationEnvelope {
  signerType: 0 | 1;
  signerSignature: Hex;
  ownerApprovalSignature: Hex;
  ownerApprovalValidUntil: number;
}

export interface PolicyLimits {
  maxPerTxValueWei: bigint;
  dailyLimitWei: bigint;
  requiresOwnerApproval: boolean;
  ownerApprovalThresholdWei: bigint;
}

export interface PolicyValidationInput {
  userOpHash: Hex;
  target: string;
  nativeValue: bigint;
  selector: Hex;
  recipient: string;
  tokenAmount: bigint;
  callDataHash: Hex;
  ownerApprovalSignature: Hex;
  ownerApprovalValidUntil: number;
}

export interface PendingApprovalRecord {
  target: string;
  selector: Hex;
  callDataHash: Hex;
  amount: bigint;
  agentValidUntil: number;
  tokenOperation: boolean;
  ownerApprovalRequired: boolean;
  consumed: boolean;
}

export interface ExecutionResult {
  userOpHash: Hex;
  target: string;
  value: bigint;
  data: Hex;
  tokenAmount: bigint;
  selector: Hex;
}

export type BytesLikeInput = BytesLike;
