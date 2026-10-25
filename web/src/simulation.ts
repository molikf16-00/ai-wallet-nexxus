import { AttackExecutionEngine, ATTACK_CATALOG, type AttackId } from "../../src/attack-suite";
import { AnomalyBenchmark } from "../../src/anomaly-guard";
import { GuardianRecoverySimulator } from "../../src/guardian-recovery";

// Each browser tab owns its demo state. No shared server wallet or user credentials.
export const attacks = ATTACK_CATALOG;
export const runAttack = (id: AttackId) => new AttackExecutionEngine().run(id);
export const benchmark = (threshold: number) => new AnomalyBenchmark().run(threshold);
export const recovery = new GuardianRecoverySimulator(
  "0xa100000000000000000000000000000000000001",
  "0xa200000000000000000000000000000000000002",
);
export function recoveryAction(path: string, body: Record<string, unknown>) {
  const guardian = String(body.guardian ?? "");
  switch (path.split("/").pop()) {
    case "initiate": recovery.initiateRecovery(guardian, String(body.newKey ?? ""), body.target === "owner" ? "owner" : "agent"); break;
    case "approve": recovery.approveRecovery(guardian); break;
    case "veto": recovery.vetoRecovery(String(body.owner ?? "")); break;
    case "fast-forward": recovery.fastForward(Number(body.seconds)); break;
    case "execute": recovery.executeRecovery(guardian); break;
    default: throw new Error("Unknown recovery action");
  }
  return recovery.getState();
}
