import assert from "node:assert/strict";
import handler, { validateInterpretation } from "../api/intent.js";
import type { IncomingMessage, ServerResponse } from "node:http";
const originalFetch = globalThis.fetch;
const originalEnv = { key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, enabled: process.env.ENABLE_AI_PLANNER };
async function call(method: string, body?: unknown) {
  let status = 0, payload: any;
  const response = { writeHead(code: number) { status = code; }, end(value: string) { payload = JSON.parse(value); } };
  await handler({ method, body } as IncomingMessage & {body?: unknown}, response as unknown as ServerResponse);
  return { status, payload };
}
try {
  delete process.env.OPENAI_API_KEY;
  assert.deepEqual((await call("GET")).payload, { available: false });
  assert.equal((await call("POST", {request:"Pay"})).status, 503);
  process.env.OPENAI_API_KEY = "test-placeholder";
  process.env.OPENAI_MODEL = "test-model";
  process.env.ENABLE_AI_PLANNER = "true";
  assert.equal((await call("GET")).payload.available, true);
  assert.equal((await call("DELETE")).status, 405);
  assert.equal((await call("POST", {request:""})).status, 400);
  assert.equal((await call("POST", {request:"x".repeat(2001)})).status, 400);
  const proposal = { action: "payment", amount: "0.005", recipient: "0x5000000000000000000000000000000000000005", message: "Review this payment." };
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    assert.equal(request.store, false);
    assert.equal(request.text.format.strict, true);
    assert.equal(request.tools, undefined);
    return new Response(JSON.stringify({ status:"completed", output:[{content:[{type:"output_text",text:JSON.stringify(proposal)}]}]}), {status:200});
  };
  assert.deepEqual((await call("POST", {request:"Pay 0.005 ETH for inference"})).payload, proposal);
  globalThis.fetch = async () => new Response("unavailable", {status:429});
  assert.equal((await call("POST", {request:"Pay"})).status, 429);
  globalThis.fetch = async () => new Response(JSON.stringify({status:"incomplete",output:[]}));
  assert.equal((await call("POST", {request:"Pay"})).status, 502);
  assert.throws(() => validateInterpretation({...proposal, amount:"NaN"}));
  assert.throws(() => validateInterpretation({...proposal, recipient:"not-an-address"}));
  assert.throws(() => validateInterpretation({action:"execute"}));
  console.log("AI endpoint configuration, validation, model proposal, rate-limit and incomplete-response tests passed (mocked provider).");
} finally {
  globalThis.fetch = originalFetch;
  for (const [key,value] of Object.entries({OPENAI_API_KEY:originalEnv.key,OPENAI_MODEL:originalEnv.model,ENABLE_AI_PLANNER:originalEnv.enabled})) {
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
}
