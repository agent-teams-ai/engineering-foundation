import { spawn } from "node:child_process";
import test from "node:test";

test("coverage worker does not forward collection to its subprocess", async () => {
  process.stdout.write(`worker-pid:${process.pid}\n`);
  const child = spawn(process.execPath, ["--eval", "process.exitCode = 0"], {
    stdio: "ignore",
  });
  process.stdout.write(`grandchild-pid:${child.pid}\n`);
  const exitCode = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
  if (exitCode !== 0) {
    throw new Error(`coverage process-tree fixture child failed with ${exitCode}`);
  }
});
