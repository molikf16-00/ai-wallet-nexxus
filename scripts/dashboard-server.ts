import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AttackExecutionEngine, ATTACK_CATALOG, type AttackId } from "../src/attack-suite.js";
import { AnomalyBenchmark } from "../src/anomaly-guard.js";
import { DEFAULT_GUARDIANS, GuardianRecoverySimulator } from "../src/guardian-recovery.js";
import intentHandler from "../api/intent.js";
import copilotHandler from "../api/copilot.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dashboardRoot = join(root, "dashboard");
const frontendRoot = join(root, "web", "dist");
const engine = new AttackExecutionEngine();
const anomalyBenchmark = new AnomalyBenchmark();
const recovery = new GuardianRecoverySimulator(
  "0xa100000000000000000000000000000000000001",
  "0xa200000000000000000000000000000000000002",
);
const port = Number(process.env.PORT ?? 4173);

function sendJson(response: import("node:http").ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

async function sendFile(response: import("node:http").ServerResponse, fileName: string, contentType: string): Promise<void> {
  try {
    const body = await readFile(join(dashboardRoot, fileName));
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  }
}

async function sendFrontendFile(response: import("node:http").ServerResponse, fileName: string, contentType: string): Promise<void> {
  try {
    const body = await readFile(join(frontendRoot, fileName));
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    response.end(body);
  } catch {
    await sendFile(response, "index.html", "text/html; charset=utf-8");
  }
}

async function collectSources(directory: string, output: ContractSource[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectSources(path, output);
    else if (entry.name.endsWith(".sol")) {
      const source = await readFile(path, "utf8");
      const name = path.slice(directoryRoot.length + 1).replaceAll("\\", "/");
      const artifactPath = join(root, "artifacts", `${entry.name.slice(0, -4)}.json`);
      let abi: unknown[] = [];
      let bytecodeLength = 0;
      try {
        const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as { abi?: unknown[]; evm?: { bytecode?: { object?: string } } };
        abi = artifact.abi ?? [];
        bytecodeLength = Math.floor((artifact.evm?.bytecode?.object?.length ?? 0) / 2);
      } catch {
        abi = [];
      }
      output.push({ name, source, abi, bytecodeLength });
    }
  }
}

const directoryRoot = join(root, "contracts");
interface ContractSource { name: string; source: string; abi: unknown[]; bytecodeLength: number; }

async function readJson(request: import("node:http").IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, string>;
}

function sendRecoveryError(response: import("node:http").ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  response.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: message }));
}

function contentTypeFor(path: string): string {
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/api/copilot") {
    await copilotHandler(request, response);
    return;
  }
  if (url.pathname === "/api/intent") {
    await intentHandler(request, response);
    return;
  }
  if (url.pathname === "/api/attacks") {
    sendJson(response, 200, ATTACK_CATALOG);
    return;
  }
  if (url.pathname.startsWith("/api/attack/")) {
    const id = url.pathname.slice("/api/attack/".length) as AttackId;
    if (!ATTACK_CATALOG.some((entry) => entry.id === id)) {
      sendJson(response, 404, { error: "unknown attack" });
      return;
    }
    sendJson(response, 200, engine.run(id));
    return;
  }
  if (url.pathname === "/api/anomaly/benchmark") {
    const rawThreshold = Number(url.searchParams.get("threshold") ?? "75");
    const threshold = Number.isFinite(rawThreshold) ? Math.min(100, Math.max(1, Math.round(rawThreshold))) : 75;
    sendJson(response, 200, anomalyBenchmark.run(threshold));
    return;
  }
  if (url.pathname === "/api/contracts" && request.method === "GET") {
    const contracts: ContractSource[] = [];
    await collectSources(directoryRoot, contracts);
    sendJson(response, 200, { contracts: contracts.sort((left, right) => left.name.localeCompare(right.name)) });
    return;
  }
  if (url.pathname === "/api/recovery/state" && request.method === "GET") {
    sendJson(response, 200, recovery.getState());
    return;
  }
  if (url.pathname === "/api/recovery/initiate" && request.method === "POST") {
    try {
      const body = await readJson(request);
      recovery.initiateRecovery(body.guardian ?? DEFAULT_GUARDIANS[0].address, body.newKey ?? "0xa300000000000000000000000000000000000003", body.target === "owner" ? "owner" : "agent");
      sendJson(response, 200, recovery.getState());
    } catch (error) {
      sendRecoveryError(response, error);
    }
    return;
  }
  if (url.pathname === "/api/recovery/approve" && request.method === "POST") {
    try {
      const body = await readJson(request);
      recovery.approveRecovery(body.guardian ?? DEFAULT_GUARDIANS[0].address);
      sendJson(response, 200, recovery.getState());
    } catch (error) {
      sendRecoveryError(response, error);
    }
    return;
  }
  if (url.pathname === "/api/recovery/veto" && request.method === "POST") {
    try {
      const body = await readJson(request);
      recovery.vetoRecovery(body.owner ?? recovery.owner);
      sendJson(response, 200, recovery.getState());
    } catch (error) {
      sendRecoveryError(response, error);
    }
    return;
  }
  if (url.pathname === "/api/recovery/fast-forward" && request.method === "POST") {
    try {
      const body = await readJson(request);
      recovery.fastForward(body.seconds ? Number(body.seconds) : recovery.delaySeconds);
      sendJson(response, 200, recovery.getState());
    } catch (error) {
      sendRecoveryError(response, error);
    }
    return;
  }
  if (url.pathname === "/api/recovery/execute" && request.method === "POST") {
    try {
      const body = await readJson(request);
      recovery.executeRecovery(body.guardian ?? DEFAULT_GUARDIANS[0].address);
      sendJson(response, 200, recovery.getState());
    } catch (error) {
      sendRecoveryError(response, error);
    }
    return;
  }
  if (url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (url.pathname === "/dashboard.js") {
    await sendFile(response, "dashboard.js", "text/javascript; charset=utf-8");
    return;
  }
  if (url.pathname === "/fuzz-worker.js") {
    await sendFile(response, "fuzz-worker.js", "text/javascript; charset=utf-8");
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    await sendFrontendFile(response, url.pathname.slice(1), contentTypeFor(url.pathname));
    return;
  }
  await sendFrontendFile(response, "index.html", "text/html; charset=utf-8");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`AgentWallet defense dashboard listening on http://127.0.0.1:${port}`);
});
