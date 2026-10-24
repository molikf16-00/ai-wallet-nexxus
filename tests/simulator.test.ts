import assert from "node:assert/strict";
import { HDNodeWallet, Interface, Wallet, keccak256, parseEther, toUtf8Bytes } from "ethers";
import {
  AgentSmartAccountSimulator,
  ERC20_TRANSFER_SELECTOR,
  EXECUTE_SELECTOR,
  PolicyEngineSimulator,
  PolicyViolation,
  encodeAuthorization,
  encodeExecution,
  packNonce,
} from "../src/simulator.js";
import type { ExecutionCall, Hex, UserOperationV06 } from "../src/types.js";

const TOKEN_INTERFACE = new Interface(["function transfer(address to,uint256 amount)"]);
const ACCOUNT_ADDRESS = "0x1000000000000000000000000000000000000001";
const TOKEN_ADDRESS = "0x2000000000000000000000000000000000000002";
const RECIPIENT = "0x3000000000000000000000000000000000000003";

function makeUserOp(callData: Hex, nonce: bigint, signature: Hex): UserOperationV06 {
  return {
    sender: ACCOUNT_ADDRESS,
    nonce,
    initCode: "0x",
    callData,
    callGasLimit: 500_000n,
    verificationGasLimit: 500_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    paymasterAndData: "0x",
    signature,
  };
}

async function signAgent(wallet: HDNodeWallet, userOpHash: Hex, approvalSignature: Hex = "0x", approvalValidUntil = 0): Promise<Hex> {
  return encodeAuthorization({
    signerType: 1,
    signerSignature: await wallet.signMessage(Buffer.from(userOpHash.slice(2), "hex")) as Hex,
    ownerApprovalSignature: approvalSignature,
    ownerApprovalValidUntil: approvalValidUntil,
  });
}

function expectPolicy(code: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof PolicyViolation && error.code === code);
}

async function testNativeTransferAnd2DNonce(): Promise<void> {
  const owner = Wallet.createRandom();
  const agent = Wallet.createRandom();
  const engine = new PolicyEngineSimulator(ACCOUNT_ADDRESS, owner.address, 1_700_000_000, "0x4000000000000000000000000000000000000004");
  engine.setAgentKey(agent.address, engine.now + 3_600);
  engine.setLimits(parseEther("100"), parseEther("500"));
  engine.setAllowedRecipient(RECIPIENT, true);
  const account = new AgentSmartAccountSimulator(ACCOUNT_ADDRESS, owner.address, engine);

  const hash = keccak256(toUtf8Bytes("native-transfer")) as Hex;
  const execution: ExecutionCall = { userOpHash: hash, target: RECIPIENT, value: parseEther("2"), data: "0x" };
  const callData = encodeExecution(execution);
  const signature = await signAgent(agent, hash);
  const userOp = makeUserOp(callData, packNonce(7n, 0n), signature);
  assert.equal(account.validateUserOp(userOp, hash), engine.agentValidUntil);
  const result = account.execute(execution);
  assert.equal(result.target, RECIPIENT);
  assert.equal(engine.spentTodayWei, parseEther("2"));
  assert.equal(engine.currentNativeSpend(), parseEther("2"));

  const secondHash = keccak256(toUtf8Bytes("parallel-workstream")) as Hex;
  const secondExecution: ExecutionCall = { userOpHash: secondHash, target: RECIPIENT, value: parseEther("1"), data: "0x" };
  const secondCallData = encodeExecution(secondExecution);
  const secondUserOp = makeUserOp(secondCallData, packNonce(8n, 0n), await signAgent(agent, secondHash));
  assert.equal(account.validateUserOp(secondUserOp, secondHash), engine.agentValidUntil);
  account.execute(secondExecution);
  assert.equal(engine.spentTodayWei, parseEther("3"));

  const replay = makeUserOp(callData, packNonce(7n, 0n), signature);
  expectPolicy("InvalidNonce", () => account.validateUserOp(replay, hash));
}

async function testSelectorAndRecipientPolicy(): Promise<void> {
  const owner = Wallet.createRandom();
  const agent = Wallet.createRandom();
  const engine = new PolicyEngineSimulator(ACCOUNT_ADDRESS, owner.address, 1_700_000_000, "0x4000000000000000000000000000000000000004");
  engine.setAgentKey(agent.address, engine.now + 3_600);
  engine.setLimits(1_000n, 10_000n);
  engine.setAllowedTarget(TOKEN_ADDRESS, true);
  engine.setAllowedSelector(TOKEN_ADDRESS, ERC20_TRANSFER_SELECTOR, true);
  const account = new AgentSmartAccountSimulator(ACCOUNT_ADDRESS, owner.address, engine);
  const hash = keccak256(toUtf8Bytes("bad-selector")) as Hex;
  const innerData = TOKEN_INTERFACE.encodeFunctionData("transfer", [RECIPIENT, 10n]) as Hex;
  const badInnerData = `${"0xdeadbeef"}${innerData.slice(10)}` as Hex;
  const execution: ExecutionCall = { userOpHash: hash, target: TOKEN_ADDRESS, value: 0n, data: badInnerData };
  const userOp = makeUserOp(encodeExecution(execution), packNonce(1n, 0n), await signAgent(agent, hash));
  expectPolicy("PolicyViolation_SelectorNotAllowed", () => account.validateUserOp(userOp, hash));
}

async function testOwnerApprovalEscalation(): Promise<void> {
  const owner = Wallet.createRandom();
  const agent = Wallet.createRandom();
  const engine = new PolicyEngineSimulator(ACCOUNT_ADDRESS, owner.address, 1_700_000_000, "0x4000000000000000000000000000000000000004");
  const validUntil = engine.now + 3_600;
  engine.setAgentKey(agent.address, validUntil);
  engine.setLimits(1_000n, 100n);
  engine.setOwnerApprovalPolicy(true, 50n);
  engine.setAllowedTarget(TOKEN_ADDRESS, true);
  engine.setAllowedSelector(TOKEN_ADDRESS, ERC20_TRANSFER_SELECTOR, true);
  engine.setAllowedRecipient(RECIPIENT, true);
  const account = new AgentSmartAccountSimulator(ACCOUNT_ADDRESS, owner.address, engine);

  const hash = keccak256(toUtf8Bytes("approval-required")) as Hex;
  const innerData = TOKEN_INTERFACE.encodeFunctionData("transfer", [RECIPIENT, 60n]) as Hex;
  const execution: ExecutionCall = { userOpHash: hash, target: TOKEN_ADDRESS, value: 0n, data: innerData };
  const input = {
    userOpHash: hash,
    target: TOKEN_ADDRESS,
    nativeValue: 0n,
    tokenAmount: 60n,
    selector: innerData.slice(0, 10) as Hex,
    recipient: RECIPIENT,
    callDataHash: keccak256(innerData) as Hex,
    ownerApprovalSignature: "0x" as Hex,
    ownerApprovalValidUntil: validUntil,
  };
  const approval = await owner.signTypedData(
    { name: "AgentWallet Policy", version: "1", chainId: 1, verifyingContract: engine.policyEngineAddress },
    {
      OwnerApproval: [
        { name: "userOpHash", type: "bytes32" },
        { name: "target", type: "address" },
        { name: "nativeValue", type: "uint256" },
        { name: "tokenAmount", type: "uint256" },
        { name: "callDataHash", type: "bytes32" },
        { name: "validUntil", type: "uint48" },
      ],
    },
    {
      userOpHash: input.userOpHash,
      target: input.target,
      nativeValue: input.nativeValue,
      tokenAmount: input.tokenAmount,
      callDataHash: input.callDataHash,
      validUntil: input.ownerApprovalValidUntil,
    },
  ) as Hex;
  const userOp = makeUserOp(encodeExecution(execution), packNonce(2n, 0n), await signAgent(agent, hash, approval, validUntil));
  account.validateUserOp(userOp, hash);
  account.execute(execution);
  assert.equal(engine.spentTodayTokenUnits.get(TOKEN_ADDRESS.toLowerCase()), 60n);
}

async function testExpiryAndRollingWindow(): Promise<void> {
  const owner = Wallet.createRandom();
  const agent = Wallet.createRandom();
  const engine = new PolicyEngineSimulator(ACCOUNT_ADDRESS, owner.address, 1_700_000_000, "0x4000000000000000000000000000000000000004");
  engine.setAgentKey(agent.address, engine.now + 100);
  engine.setLimits(100n, 100n);
  engine.setAllowedRecipient(RECIPIENT, true);
  const account = new AgentSmartAccountSimulator(ACCOUNT_ADDRESS, owner.address, engine);
  const hash = keccak256(toUtf8Bytes("expiry")) as Hex;
  const execution: ExecutionCall = { userOpHash: hash, target: RECIPIENT, value: 80n, data: "0x" };
  const userOp = makeUserOp(encodeExecution(execution), packNonce(3n, 0n), await signAgent(agent, hash));
  account.validateUserOp(userOp, hash);
  account.execute(execution);
  expectPolicy("PolicyViolation_DailyLimitExceeded", () => {
    const nextHash = keccak256(toUtf8Bytes("daily")) as Hex;
    const nextExecution = { userOpHash: nextHash, target: RECIPIENT, value: 30n, data: "0x" as Hex };
    const nextUserOp = makeUserOp(encodeExecution(nextExecution), packNonce(3n, 1n), "0x" as Hex);
    void nextUserOp;
    engine.validateUserOpPolicy({
      userOpHash: nextHash,
      target: RECIPIENT,
      nativeValue: 30n,
      tokenAmount: 0n,
      selector: "0x00000000",
      recipient: RECIPIENT,
      callDataHash: keccak256("0x") as Hex,
      ownerApprovalSignature: "0x",
      ownerApprovalValidUntil: 0,
    });
  });
  engine.advanceTime(86_400);
  const freshHash = keccak256(toUtf8Bytes("fresh-window")) as Hex;
  const freshExecution: ExecutionCall = { userOpHash: freshHash, target: RECIPIENT, value: 90n, data: "0x" };
  const freshUserOp = makeUserOp(encodeExecution(freshExecution), packNonce(4n, 0n), await signAgent(agent, freshHash));
  expectPolicy("PolicyViolation_ExpiredKey", () => account.validateUserOp(freshUserOp, freshHash));
}

async function main(): Promise<void> {
  await testNativeTransferAnd2DNonce();
  await testSelectorAndRecipientPolicy();
  await testOwnerApprovalEscalation();
  await testExpiryAndRollingWindow();
  console.log("4 simulator tests passed.");
}

await main();

void EXECUTE_SELECTOR;
