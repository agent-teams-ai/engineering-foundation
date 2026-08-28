import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  cleanupSyntheticFixture,
  createSyntheticFixtureBoundary,
  startBoundedCli,
  waitForFixtureEffect,
  writeFixtureBoundaryClient,
} from "./support/quality-gate-runner-lifecycle.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repositoryRoot, "packages", "engineering-foundation", "dist", "cli.js");
const roles = ["parent", "descendant"];

async function resolveInstalledPnpm(root) {
  assert.equal(
    typeof process.env.npm_execpath,
    "string",
    "Run the focused lifecycle script through the installed pnpm.",
  );
  const version = /^pnpm\/(?<version>\d+\.\d+\.\d+)\b/u.exec(
    process.env.npm_config_user_agent ?? "",
  )?.groups?.version;
  assert.notEqual(version, undefined, "Installed pnpm did not report its exact version.");
  const entrypoint = await realpath(process.env.npm_execpath);
  assert.match(entrypoint, /\.(?:c|m)?js$/u);
  const nodeOnlyPath = join(root, "node-only-path");
  await mkdir(nodeOnlyPath);
  const nodeEntrypoint = join(nodeOnlyPath, process.platform === "win32" ? "node.exe" : "node");
  if (process.platform === "win32") {
    await copyFile(process.execPath, nodeEntrypoint);
  } else {
    await symlink(process.execPath, nodeEntrypoint);
    await symlink("/bin/sh", join(nodeOnlyPath, "sh"));
  }
  return { entrypoint, nodeOnlyPath, version };
}

async function writeConsumer(root, version, timeoutMs) {
  await mkdir(join(root, "architecture", "foundation"), { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "quality-gate-real-pnpm-lifecycle-consumer",
    packageManager: `pnpm@${version}`,
    private: true,
    scripts: { slow: "node real-pnpm-parent.cjs" },
  }, null, 2)}\n`, "utf8");
  await writeFile(join(root, "foundation.config.yaml"), `schemaVersion: 1
project:
  id: quality-gate-real-pnpm-lifecycle
capabilities:
  quality.gate-runner:
    configPath: architecture/foundation/quality-gates.yaml
`, "utf8");
  const timeoutSource = timeoutMs === undefined ? "" : `\n        timeoutMs: ${timeoutMs}`;
  await writeFile(join(root, "architecture", "foundation", "quality-gates.yaml"), `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: slow${timeoutSource}
`, "utf8");
}

async function writeManagedTask(root, boundary, marker, installedPnpmEntrypoint) {
  await writeFixtureBoundaryClient(root);
  const descendantEnvironment = boundary.environmentFor("descendant");
  const descendantSource = `const { connect } = require("./fixture-boundary-client.cjs");
void (async () => {
  await connect();
  process.send?.("ready");
  setInterval(() => {}, 60000);
})().catch((error) => { throw error; });
`;
  await writeFile(join(root, "real-pnpm-parent.cjs"), `const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { realpathSync, writeFileSync } = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { connect } = require("./fixture-boundary-client.cjs");

void (async () => {
if (process.env.npm_lifecycle_event !== "slow") {
  throw new Error("Installed pnpm did not set npm_lifecycle_event=slow.");
}
const canonicalNpmExecPath = realpathSync(process.env.npm_execpath);
if (canonicalNpmExecPath !== ${JSON.stringify(installedPnpmEntrypoint)}) {
  throw new Error("Installed pnpm child npm_execpath was not the expected entrypoint.");
}
let descendant;
const stopDescendant = async () => {
  if (descendant === undefined || descendant.exitCode !== null || descendant.signalCode !== null) return;
  descendant.kill("SIGTERM");
  const closed = await Promise.race([once(descendant, "close").then(() => true), delay(1000, false)]);
  if (!closed && descendant.exitCode === null && descendant.signalCode === null) descendant.kill("SIGKILL");
  if (!closed) await once(descendant, "close");
};
await connect(stopDescendant);
descendant = spawn(process.execPath, ["--eval", ${JSON.stringify(descendantSource)}], {
  env: { ...process.env, ...${JSON.stringify(descendantEnvironment)} },
  stdio: ["ignore", "ignore", "ignore", "ipc"]
});
await once(descendant, "message");
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  evidenceId: process.env.QGR_FIXTURE_BOUNDARY_ID,
  lifecycleEvent: process.env.npm_lifecycle_event,
  npmExecPath: canonicalNpmExecPath,
  roles: ${JSON.stringify(roles)}
}) + "\\n", { flag: "wx" });
setInterval(() => {}, 60000);
})().catch((error) => { throw error; });
`, "utf8");
}

async function prepareCase(root, boundary, timeoutMs) {
  const installed = await resolveInstalledPnpm(root);
  await writeConsumer(root, installed.version, timeoutMs);
  const marker = join(root, ".real-pnpm-readiness.json");
  await writeManagedTask(root, boundary, marker, installed.entrypoint);
  const fixtureStore = join(root, ".pnpm-store");
  const setupExecution = startBoundedCli(installed.entrypoint, [
    "install", "--frozen-lockfile=false", "--ignore-scripts", "--store-dir", fixtureStore,
  ], {
    cwd: root,
    env: { ...process.env, npm_config_store_dir: fixtureStore },
  });
  const setupResult = await setupExecution.result;
  assert.equal(setupResult.status, 0, JSON.stringify(setupResult));
  const childEnvironment = {
    ...process.env,
    PATH: installed.nodeOnlyPath,
    npm_config_store_dir: fixtureStore,
    npm_execpath: installed.entrypoint,
  };
  delete childEnvironment.PNPM_HOME;
  const execution = startBoundedCli(cliPath, [
    "gate", "run", "verify", "--consumer", root, "--format", "json",
  ], {
    env: childEnvironment,
    fixtureBoundary: boundary,
    fixtureRole: "parent",
  });
  return {
    execution,
    installedPnpmEntrypoint: installed.entrypoint,
    marker,
    setupExecution,
  };
}

async function completeAfterRolesStop(boundary, execution) {
  let cliCompleted = false;
  const completion = execution.result.then((result) => {
    cliCompleted = true;
    return result;
  });
  await boundary.assertStopped();
  assert.equal(cliCompleted, false, "owned roles must close before final CLI completion");
  return await completion;
}

test("real installed pnpm timeout closes live parent and descendant before CLI completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-real-pnpm-timeout-"));
  let boundary;
  let execution;
  let installedPnpmEntrypoint;
  let marker;
  let setupExecution;
  try {
    boundary = await createSyntheticFixtureBoundary({
      expectedRoles: roles,
      shutdownGraceMs: 20_000,
    });
    ({ execution, installedPnpmEntrypoint, marker, setupExecution } = await prepareCase(
      root,
      boundary,
      10_000,
    ));
    await waitForFixtureEffect(marker, execution, (source) => {
      const readiness = JSON.parse(source);
      assert.deepEqual(readiness, {
        evidenceId: boundary.evidenceId,
        lifecycleEvent: "slow",
        npmExecPath: installedPnpmEntrypoint,
        roles,
      });
      return readiness;
    });
    await boundary.waitForRoles();
    await boundary.assertActive();
    const result = await completeAfterRolesStop(boundary, execution);
    assert.equal(result.status, 124, JSON.stringify(result));
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "failed");
    assert.deepEqual(report.tasks.map(({ id, outcome }) => [id, outcome]), [
      ["slow", "timed-out"],
    ]);
  } finally {
    await cleanupSyntheticFixture({
      boundaries: [boundary],
      executions: [setupExecution, execution],
      roots: [root],
    });
  }
});

test("real installed pnpm POSIX cancellation closes live roles before CLI completion", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-real-pnpm-sigterm-"));
  let boundary;
  let execution;
  let installedPnpmEntrypoint;
  let marker;
  let setupExecution;
  try {
    boundary = await createSyntheticFixtureBoundary({ expectedRoles: roles });
    ({ execution, installedPnpmEntrypoint, marker, setupExecution } = await prepareCase(
      root,
      boundary,
    ));
    await waitForFixtureEffect(marker, execution, (source) => {
      const readiness = JSON.parse(source);
      assert.deepEqual(readiness, {
        evidenceId: boundary.evidenceId,
        lifecycleEvent: "slow",
        npmExecPath: installedPnpmEntrypoint,
        roles,
      });
      return readiness;
    });
    await boundary.waitForRoles();
    await boundary.assertActive();
    assert.equal(execution.command.kill("SIGTERM"), true);
    const result = await completeAfterRolesStop(boundary, execution);
    assert.deepEqual({ code: result.status, signal: result.signal }, { code: 143, signal: null });
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "cancelled");
    assert.deepEqual(report.tasks.map(({ id, outcome }) => [id, outcome]), [
      ["slow", "cancelled"],
    ]);
  } finally {
    await cleanupSyntheticFixture({
      boundaries: [boundary],
      executions: [setupExecution, execution],
      roots: [root],
    });
  }
});
