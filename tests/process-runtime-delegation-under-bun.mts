import assert from "node:assert/strict";

import {
  NodeProcessRunner,
  executeManagedProcess
} from "../packages/engineering-foundation/dist/process-execution/node-process-runner.js";
import { readProcessFailureFacts } from "../packages/engineering-foundation/dist/features/validation-reporting/process-failure-facts.js";
import { requireAdmittedNodeExecutable } from "../packages/engineering-foundation/dist/process-execution/node-runtime-verifier.js";

const explicitNode = process.env["PROCESS_RUNTIME_DELEGATION_NODE"];
if (typeof explicitNode !== "string") {
  throw new Error("Explicit Node is required for the Bun transport proof.");
}
assert.ok("bun" in process.versions, "this fixture must execute under Bun");
assert.equal(requireAdmittedNodeExecutable({
  AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: explicitNode
}, process.execPath), explicitNode);

const result = await executeManagedProcess({
  command: explicitNode,
  args: ["-e", "process.stdout.write(JSON.stringify({execPath:process.execPath,versions:process.versions}))"],
  cwd: process.cwd(),
  timeoutMs: 5_000
});
const child = JSON.parse(result.stdout) as { execPath: string; versions: Record<string, string> };
assert.equal(child.versions["node"], "26.11.1");
assert.equal("bun" in child.versions, false);

const nonzero = await executeManagedProcess({
  command: explicitNode,
  args: ["-e", "process.exitCode=17"],
  cwd: process.cwd(),
  timeoutMs: 5_000
});
assert.equal(nonzero.exitCode, 17);
assert.deepEqual({ ...readProcessFailureFacts(nonzero) }, { reason: "exit", exitCode: 17 });

await assert.rejects(new NodeProcessRunner().run({
  command: explicitNode,
  args: ["-e", "process.exitCode=17"],
  cwd: process.cwd(),
  timeoutMs: 5_000
}), (error: unknown) => {
  assert.equal(readProcessFailureFacts(error)?.reason, "exit");
  return true;
});

process.stdout.write(JSON.stringify({
  transport: "node-child-process-adapter-inside-bun",
  hostRuntime: process.versions["bun"],
  hostExecutable: process.execPath,
  childExecutable: child.execPath,
  childNode: child.versions["node"]
}));
