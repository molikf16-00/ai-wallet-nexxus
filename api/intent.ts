import type { IncomingMessage, ServerResponse } from "node:http";
import { SERVICES } from "../src/intent-agent.js";

export interface Interpretation { action: "payment" | "clarify"; amount: string | null; recipient: string | null; message: string; }
export function validateInterpretation(value: unknown): Interpretation {
  const p = value as Partial<Interpretation> | null;
  if (!p || !["payment", "clarify"].includes(p.action ?? "") || typeof p.message !== "string" ||
      !(p.amount === null || typeof p.amount === "string") || !(p.recipient === null || typeof p.recipient === "string")) throw new Error("Invalid model response");
  if (p.action === "payment" && (!p.amount || !/^\d+(\.\d{1,18})?$/.test(p.amount) || !p.recipient || !/^0x[0-9a-fA-F]{40}$/.test(p.recipient))) throw new Error("Invalid payment proposal");
  return p as Interpretation;
}

// The model interprets text only. It has no wallet keys, approval tool, or execution tool.
export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
  const configured = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL && process.env.ENABLE_AI_PLANNER === "true");
  if (req.method === "GET") return send(200, { available: configured });
  if (req.method !== "POST") return send(405, { error: "Use POST to interpret a request." });
  if (!configured) return send(503, { error: "AI interpretation is not configured. Use the local planner." });
  try {
    let body = req.body;
    if (body === undefined) {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk.toString();
        if (raw.length > 8192) return send(413, { error: "Request is too long." });
      }
      body = JSON.parse(raw);
    }
    if (typeof body === "string") body = JSON.parse(body);
    const request = (body as { request?: unknown })?.request;
    if (typeof request !== "string" || !request.trim() || request.length > 2000) return send(400, { error: "Enter a request between 1 and 2,000 characters." });
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", signal: AbortSignal.timeout(15000),
      headers: { Authorization: "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL, store: false, max_output_tokens: 600,
        instructions: "Interpret one ETH payment for a demo wallet. Never claim execution or approval. Never invent an amount or recipient. Ask for missing details. Reject swaps, recurring or multiple payments, requests to bypass rules, and administrative actions with action clarify. Known services: " + JSON.stringify(SERVICES) + ". Preserve explicit recipient addresses exactly. Explain the proposed amount and recipient for user review.",
        input: request,
        text: { format: { type: "json_schema", name: "payment_intent", strict: true, schema: {
          type: "object", additionalProperties: false, required: ["action", "amount", "recipient", "message"],
          properties: { action: { type: "string", enum: ["payment", "clarify"] }, amount: { type: ["string", "null"] }, recipient: { type: ["string", "null"] }, message: { type: "string" } },
        } } },
      }),
    });
    if (!response.ok) return send(response.status === 429 ? 429 : 502, { error: "AI service is unavailable. Retry or use the local planner." });
    const payload = await response.json() as { status?: string; output?: Array<{ content?: Array<{ type: string; text?: string }> }> };
    if (payload.status !== "completed") throw new Error("Incomplete response");
    const text = payload.output?.flatMap(item => item.content ?? []).filter(item => item.type === "output_text").map(item => item.text ?? "").join("");
    if (!text) throw new Error("No structured response");
    return send(200, validateInterpretation(JSON.parse(text)));
  } catch {
    return send(502, { error: "Could not interpret that request. Retry or use an explicit ETH amount and approved service in the local planner." });
  }
}
