import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
const root = join(import.meta.dirname, "..");
const contracts: Array<{name: string; source: string; abi: unknown[]; bytecodeLength: number}> = [];
function collect(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.name.endsWith(".sol")) {
      const source = readFileSync(path, "utf8");
      const artifactPath = join(root, "artifacts", entry.name.replace(".sol", ".json"));
      let artifact = { abi: [] as unknown[], evm: { bytecode: { object: "" } } };
      try { artifact = JSON.parse(readFileSync(artifactPath, "utf8")); } catch {
        // Struct-only sources have no compiled artifact.
        if (/\b(contract|interface|library)\s+\w+/.test(source)) throw new Error("Missing compiled artifact: " + entry.name);
      }
      contracts.push({ name: relative(join(root, "contracts"), path).replaceAll("\\", "/"), source, abi: artifact.abi, bytecodeLength: artifact.evm.bytecode.object.length / 2 });
    }
  }
}
collect(join(root, "contracts"));
mkdirSync(join(root, "web/public"), { recursive: true });
writeFileSync(join(root, "web/public/contracts.json"), JSON.stringify({ contracts }));
