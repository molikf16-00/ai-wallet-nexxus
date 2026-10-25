import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const source = readFileSync(new URL("../web/public/fuzz-worker.js", import.meta.url), "utf8");
for (const flawedContract of [false,true]) {
  const messages: any[] = [];
  const context = { self: {} as { onmessage: (event: unknown) => void }, performance, postMessage: (message: unknown) => {
    // UI renders counterexamples as JSON; BigInts must be normalized.
    JSON.stringify(message);
    messages.push(message);
  } };
  runInNewContext(source, context);
  context.self.onmessage({ data: { iterations:5000, flawedContract, seed:0xa9e17 } });
  const last = messages.at(-1);
  assert.equal(last.type, "complete");
  assert.equal(last.totalMutationsEvaluated, flawedContract ? 1 : 5000);
  assert.equal(last.violationsDetected, flawedContract ? 1 : 0);
}
console.log("Browser worker safe and flawed runs complete with JSON-safe results.");
