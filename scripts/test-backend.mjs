import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();

if (files.length === 0) {
  throw new Error("No backend test files found");
}

// Bun shares mocked module namespaces between files. Each suite needs its own
// process so its VS Code mock cannot inherit a different suite's export shape.
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ["test", `tests/${file}`], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error);
  }
  if (result.error || result.status !== 0) {
    failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
