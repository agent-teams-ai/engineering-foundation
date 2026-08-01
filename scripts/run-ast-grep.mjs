import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveBinaryPath } = require("@ast-grep/cli/postinstall.js");
const binaryPath = resolveBinaryPath();

if (binaryPath === null) {
  process.stderr.write("Unable to resolve the platform ast-grep binary.\n");
  process.exitCode = 1;
} else {
  const result = spawnSync(binaryPath, process.argv.slice(2), {
    stdio: "inherit"
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}
