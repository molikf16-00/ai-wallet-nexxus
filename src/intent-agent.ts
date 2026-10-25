import { formatEther, isAddress, parseEther } from "ethers";

export const SERVICES = [
  { name: "Inference API", address: "0x5000000000000000000000000000000000000005" },
  { name: "Cloud GPU", address: "0x8200000000000000000000000000000000000002" },
];
export type TaskStatus = "needs_details" | "blocked" | "awaiting_confirmation" | "completed" | "cancelled";
export interface IntentTask {
  id: string;
  request: string;
  amount?: string;
  target?: string;
  status: TaskStatus;
  reason: string;
  steps: string[];
  events: string[];
}
export class IntentAgent {
  public spent = parseEther("0.24");
  public perTransaction = parseEther("0.05");
  public dailyLimit = parseEther("0.25");
  public paused = false;
  public allowedTargets = new Set(SERVICES.map(s => s.address));
  private sequence = 0;
  private tasks = new Map<string, IntentTask>();

  public list(): IntentTask[] {
    return [...this.tasks.values()].reverse().map(t => ({ ...t, steps: [...t.steps], events: [...t.events] }));
  }

  public plan(request: string, originalRequest = request): IntentTask {
    const task: IntentTask = {
      id: `task-${++this.sequence}`, request: originalRequest, status: "needs_details", reason: "",
      steps: ["Identify amount and recipient", "Check limits and approved recipients", "Ask for confirmation", "Run simulation and record result"],
      events: ["Request received"],
    };
    const amounts = [...request.matchAll(/(?<![\w.+-])([0-9]+(?:\.[0-9]+)?)\s*ETH\b/gi)];
    const addresses = request.match(/0x[a-zA-Z0-9]+/g) ?? [];
    const lower = request.toLowerCase();
    if (/\b(swap|bridge|stake|approve|selfdestruct|setowner|override|ignore|all funds|drain)\b/i.test(request)) {
      task.status = "blocked";
      task.reason = "This request needs an unsupported capability. Only explicit ETH payment simulations are available; no permissions were changed.";
    } else if (!/\b(pay|send|transfer)\b/i.test(request)) {
      task.reason = "Describe one payment, including its ETH amount and recipient. Example: Pay 0.005 ETH to Inference API.";
    } else if (amounts.length !== 1 || addresses.length > 1 || /\b(then|repeat|every|loop)\b/i.test(request)) {
      task.reason = "Provide one payment with one explicit ETH amount and one recipient. Batch and scheduled payments are not supported.";
    } else {
      task.amount = amounts[0][1];
      if (addresses.length) task.target = addresses[0];
      else if (lower.includes("inference")) task.target = SERVICES[0].address;
      else if (lower.includes("gpu")) task.target = SERVICES[1].address;
      if (!task.target) task.reason = "Which recipient should receive this payment? Resubmit with an approved service name or full address.";
      else {
        const error = this.check(task);
        task.status = error ? "blocked" : "awaiting_confirmation";
        task.reason = error ?? "Checks passed. Review the amount and recipient before confirming this simulation.";
      }
    }
    task.events.push(task.reason);
    this.tasks.set(task.id, task);
    return { ...task, steps: [...task.steps], events: [...task.events] };
  }

  private check(task: IntentTask): string | null {
    if (this.paused) return "The agent is paused. Resume it before creating a new payment.";
    if (!task.target || !isAddress(task.target) || !this.allowedTargets.has(task.target.toLowerCase())) return "Recipient is invalid or is not approved in Spending rules.";
    let amount: bigint;
    try { amount = parseEther(task.amount ?? ""); } catch { return "Enter a valid ETH amount with at most 18 decimal places."; }
    if (amount <= 0n) return "Amount must be greater than zero.";
    if (amount > this.perTransaction) return `Amount exceeds the ${formatEther(this.perTransaction)} ETH transaction limit.`;
    if (this.spent + amount > this.dailyLimit) return `Not enough daily allowance. Remaining: ${formatEther(this.dailyLimit > this.spent ? this.dailyLimit - this.spent : 0n)} ETH.`;
    return null;
  }

  public confirm(id: string): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== "awaiting_confirmation") throw new Error("This task is not awaiting confirmation.");
    const error = this.check(task);
    if (error) {
      task.status = "blocked"; task.reason = error; task.events.push(error); return;
    }
    this.spent += parseEther(task.amount!);
    task.status = "completed";
    task.reason = "Simulation completed. No funds moved and no transaction was broadcast.";
    task.events.push("Confirmed by user", "Current permissions and allowance checked again", task.reason);
  }

  public cancel(id: string): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== "awaiting_confirmation") throw new Error("This task cannot be cancelled.");
    task.status = "cancelled"; task.reason = "Cancelled. Daily allowance is unchanged."; task.events.push(task.reason);
  }
}
