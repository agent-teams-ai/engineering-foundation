import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  spawnWindowsManagedProcess,
  waitForWindowsManagedProcessContainment
} from "../packages/engineering-foundation/dist/process-execution/windows-managed-process.js";

const WINDOWS_CONTROL_ROOT_PREFIX = "agent-teams-foundation-process-";
const PROCESS_RUNNER_URL = new URL(
  "../packages/engineering-foundation/dist/local-mode/process-runner.js",
  import.meta.url
).href;

async function windowsControlRoots() {
  return new Set((await readdir(tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(WINDOWS_CONTROL_ROOT_PREFIX))
    .map((entry) => entry.name));
}

test("nested Windows Jobs confirm repeated normal exits", {
  skip: process.platform !== "win32",
  timeout: 90_000
}, async () => {
  const previousRoots = await windowsControlRoots();
  const root = await mkdtemp(join(tmpdir(), "foundation Windows nested Jobs "));
  const source = [
    `const { createNodeProcessRunner } = await import(${JSON.stringify(PROCESS_RUNNER_URL)});`,
    "const runner = createNodeProcessRunner(process.env);",
    "for (let index = 0; index < 4; index += 1) {",
    "  const result = await runner.run({",
    "    command: process.execPath,",
    "    args: ['-e', `process.stdout.write(${JSON.stringify('nested-ok')})`],",
    "    cwd: process.cwd()",
    "  });",
    "  if (result.stdout !== 'nested-ok') {",
    "    throw new Error('Nested managed process returned an invalid result.');",
    "  }",
    "}",
    "process.stdout.write('outer-ok');"
  ].join("\n");
  let child;
  try {
    child = spawnWindowsManagedProcess({
      command: process.execPath,
      args: ["--input-type=module", "-e", source],
      cwd: root,
      environment: process.env
    });
    let stderr = "";
    let stdout = "";
    child.stderr?.setEncoding("utf8");
    child.stdout?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    const closed = once(child, "close");
    const [exitCode] = await once(child, "exit");
    await waitForWindowsManagedProcessContainment(child);
    await closed;
    assert.equal(exitCode, 0, stderr);
    assert.equal(stdout, "outer-ok");
    assert.deepEqual(
      [...await windowsControlRoots()].filter((candidate) => !previousRoots.has(candidate)),
      []
    );
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(root, { force: true, recursive: true });
  }
});
