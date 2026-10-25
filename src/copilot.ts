import { formatEther, parseEther } from "ethers";
import { IntentAgent, type IntentTask } from "./intent-agent.js";

export const DESTINATIONS = ["overview", "copilot", "policy", "attacks", "anomaly", "recovery", "fuzzer", "contracts"] as const;
export type Destination = typeof DESTINATIONS[number];
export interface CopilotContext {
  page: Destination;
  paused: boolean;
  spent: string;
  dailyLimit: string;
  perTransaction: string;
  allowedTargets: string[];
  tasks: Pick<IntentTask, "request" | "status" | "reason">[];
}
export interface CopilotReply {
  message: string;
  destination: Destination | null;
  payment: { amount: string; recipient: string } | null;
}
export interface ConversationMessage { role: "user" | "assistant"; content: string; }

// Validate model proposals again at the browser boundary, before rendering actions.
export function validateReply(value: unknown): CopilotReply {
  if (!value || typeof value !== "object") throw new Error("The assistant returned an invalid answer.");
  const reply = value as CopilotReply;
  if (typeof reply.message !== "string" || !reply.message.trim() || reply.message.length > 4000 ||
      !(reply.destination === null || DESTINATIONS.includes(reply.destination))) throw new Error("The assistant returned an invalid answer.");
  if (reply.payment !== null) {
    const p = reply.payment;
    if (!p || typeof p.amount !== "string" || !/^\d+(\.\d{1,18})?$/.test(p.amount) ||
        typeof p.recipient !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(p.recipient) ||
        parseEther(p.amount) <= 0n) throw new Error("The assistant returned an invalid payment proposal.");
  }
  return reply;
}

export const HELP: Record<Destination, string> = {
  overview: "Overview shows your example balance, remaining demo allowance, and tasks waiting for review. Start with a payment plan or explore the safeguards.",
  copilot: "Agent tasks turns a payment request into a plan. Enter an ETH amount and approved service, review the recipient, then confirm the simulation. Planning does not spend your allowance.",
  policy: "Spending rules sets the maximum per payment, total demo allowance, and approved services. Save your changes. Pending plans are checked against the latest rules when you confirm.",
  attacks: "Security Lab runs six attack scenarios against the wallet model. Choose a scenario or run all six, then inspect its pass/fail result and trace. Each test has its own preset limits.",
  anomaly: "Anomaly Shield compares suspicious and ordinary activity across 1,000 synthetic patterns. A lower threshold pauses sooner but can interrupt more normal activity. Its figures are benchmark results, not live monitoring.",
  recovery: "To practice recovery: propose a valid replacement key address, collect approvals from three different guardians, advance the demo clock by 48 hours, and finalize. The owner can cancel an active or pending proposal. These buttons simulate signatures.",
  fuzzer: "Verification tries randomized inputs against the wallet model. Run checks normally to look for violations, or enable the deliberately flawed implementation to see a counterexample. Passing a run is not a formal proof.",
  contracts: "Contracts shows the Solidity source and ABI from this build. Select a file to inspect it or copy its code. This does not mean the contracts are deployed, audited, or verified on a block explorer.",
};

export function localReply(request: string, context: CopilotContext, pending = ""): CopilotReply & { draft?: string } {
  const lower = request.toLowerCase();
  const reply = (message: string, destination: Destination | null = null): CopilotReply => ({ message, destination, payment: null });
  if (/\b(seed phrase|private key|recovery phrase|mnemonic)\b/.test(lower)) return reply("Never paste a seed phrase or private key into chat. I only need a public recipient address to help plan a payment.");
  if (/\b(confirm|execute|approve it|cancel it)\b/.test(lower)) return reply("Open Agent tasks to review and confirm or cancel the specific plan. I cannot confirm transactions from chat.", "copilot");
  if (/\b(blocked|failed|rejected|why.*(payment|task))\b/.test(lower)) {
    const failed = context.tasks.find(task => task.status === "blocked" || task.status === "needs_details");
    return reply(failed ? "Your latest blocked or incomplete task: " + failed.reason + " Review its details before creating a revised plan." : "There is no blocked task in this session. Payments can be blocked by a pause, an unapproved recipient, or insufficient allowance.", "copilot");
  }
  if (/\b(allowance|remaining|how much|balance|status)\b/.test(lower)) {
    const remaining = parseEther(context.dailyLimit) > parseEther(context.spent) ? parseEther(context.dailyLimit) - parseEther(context.spent) : 0n;
    return reply("You have " + formatEther(remaining) + " ETH of demo allowance left. The per-payment limit is " + context.perTransaction + " ETH. The agent is " + (context.paused ? "paused" : "active") + ". The displayed 20 ETH balance is illustrative; no wallet is connected.", "policy");
  }
  const topics: Array<[RegExp, Destination]> = [
    [/\b(recover|recovery|guardian|lost.*key)\b/, "recovery"],
    [/\b(anomaly|threshold|suspicious)\b/, "anomaly"],
    [/\b(security|attack|safeguard)\b/, "attacks"],
    [/\b(verification|verify|fuzz|randomized)\b/, "fuzzer"],
    [/\b(contract|contracts|abi|solidity)\b/, "contracts"],
    [/\b(rule|rules|limit|limits|whitelist|allowlist)\b/, "policy"],
  ];
  for (const [pattern, destination] of topics) if (pattern.test(lower)) return reply(HELP[destination], destination);
  const continuation = pending && /^(?:to\s+)?(?:\d+(?:\.\d+)?\s*eth|inference(?: api)?|(?:cloud )?gpu|0x[0-9a-f]+)[.!]?$/i.test(request.trim());
  if (/\b(pay|send|transfer)\b/.test(lower) || continuation) {
    if (/\b(don't|do not|never|not now)\b/i.test(request)) return reply("No payment plan created. Ask me about your allowance or another task instead.");
    const combined = continuation ? pending + " " + request : request;
    const planner = new IntentAgent();
    planner.spent = parseEther(context.spent);
    planner.dailyLimit = parseEther(context.dailyLimit);
    planner.perTransaction = parseEther(context.perTransaction);
    planner.paused = context.paused;
    planner.allowedTargets = new Set(context.allowedTargets);
    const plan = planner.plan(combined);
    if (plan.status === "needs_details") return {
      ...reply(plan.amount
        ? "Who should receive this payment? Reply with Inference API, Cloud GPU, or the full public recipient address."
        : "What amount in ETH would you like to pay? Reply with one amount, such as 0.005 ETH."),
      draft: combined,
    };
    if (plan.status === "blocked") return reply(plan.reason + " Nothing has been executed.", "policy");
    return { message: "I can prepare a " + plan.amount + " ETH payment to " + plan.target + ". Create the plan below, then review and confirm it in Agent tasks. This is a simulation.", destination: null, payment: { amount: plan.amount!, recipient: plan.target! } };
  }
  if (/\b(this page|here|how.*start|getting started)\b/.test(lower)) return reply(HELP[context.page], context.page);
  return reply("I can help you plan a payment, check your allowance, explain a blocked task, or guide you through recovery and security checks. Try “How much can I spend?” or “How does recovery work?”");
}
