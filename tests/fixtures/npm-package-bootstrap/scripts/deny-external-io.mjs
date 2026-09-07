import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// Test-only I/O sentinels; real CLI imports and module resolution remain untouched.
let attempted = false;
function refuse() {
  attempted = true;
  throw new Error("TEST external I/O is forbidden in the clean bootstrap fixture.");
}
globalThis.fetch = refuse;
for (const name of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]) {
  childProcess[name] = refuse;
}
syncBuiltinESMExports();
process.on("exit", () => {
  if (attempted) {
    process.exitCode = 99;
  }
});
