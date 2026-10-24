import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import solc from "solc";

const root = join(import.meta.dirname, "..");
const contractsRoot = join(root, "contracts");
const sources: Record<string, { content: string }> = {};

function collect(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.name.endsWith(".sol")) sources[relative(root, path).replaceAll("\\", "/")] = { content: readFileSync(path, "utf8") };
  }
}

collect(contractsRoot);
const result = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
}), {
  import: (path: string) => sources[path] ? { contents: sources[path].content } : { error: `Missing import: ${path}` },
}));

const errors = (result.errors ?? []).filter((error: { severity: string }) => error.severity === "error");
if (errors.length > 0) {
  for (const error of errors) console.error(error.formattedMessage);
  process.exit(1);
}

const artifactsRoot = join(root, "artifacts");
mkdirSync(artifactsRoot, { recursive: true });
for (const [sourceName, contracts] of Object.entries(result.contracts ?? {})) {
  for (const [contractName, artifact] of Object.entries(contracts as Record<string, { abi: unknown; evm: { bytecode: { object: string } } }>)) {
    writeFileSync(join(artifactsRoot, `${contractName}.json`), JSON.stringify({ contractName, sourceName, ...artifact }, null, 2));
  }
}
console.log(`Compiled ${Object.values(result.contracts ?? {}).reduce((count: number, contracts) => count + Object.keys(contracts as object).length, 0)} contracts.`);
