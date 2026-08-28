import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runQualityGateCommand } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/gate-command.js";
import { PnpmQualityGateScriptExecutor } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/outbound/pnpm/pnpm-package-script-executor.js";
import {
  awaitQgrSetupBeforeTransfer,
  cleanupSyntheticFixture,
  createControlledQgrCancellationSource,
  createSyntheticFixtureBoundary,
  startBoundedCli,
  startCapturedQgrCommand,
  waitForFixtureEffect,
  writeFixtureBoundaryClient,
} from "./support/quality-gate-runner-lifecycle.mjs";

const roles = ["parent", "descendant"];
const noOp = () => {};

async function resolveInstalledPnpm() {
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
  return { entrypoint, version };
}

async function writeConsumer(root, version) {
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
  await writeFile(join(root, "architecture", "foundation", "quality-gates.yaml"), `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: slow
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

async function prepareCase(root) {
  const installed = await resolveInstalledPnpm();
  await writeConsumer(root, installed.version);
  const marker = join(root, ".real-pnpm-readiness.json");
  const fixtureStore = join(root, ".pnpm-store");
  const setupExecution = startBoundedCli(installed.entrypoint, [
    "install", "--frozen-lockfile=false", "--ignore-scripts", "--store-dir", fixtureStore,
  ], {
    cwd: root,
    env: { ...process.env, npm_config_store_dir: fixtureStore },
  });
  await awaitQgrSetupBeforeTransfer(setupExecution, (setupResult) => {
    assert.equal(setupResult.status, 0, JSON.stringify(setupResult));
  });
  return {
    fixtureStore,
    installedPnpmEntrypoint: installed.entrypoint,
    marker,
    setupExecution,
  };
}

function overrideEnvironment(overrides) {
  const previous = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

test("controlled QGR cancellation drains the real installed-pnpm process tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-real-pnpm-cancel-"));
  let boundary;
  let execution;
  let restoreEnvironment = noOp;
  let installedPnpmEntrypoint;
  let marker;
  let setupExecution;
  try {
    let fixtureStore;
    ({
      fixtureStore,
      installedPnpmEntrypoint,
      marker,
      setupExecution,
    } = await prepareCase(root));
    boundary = await createSyntheticFixtureBoundary({
      expectedRoles: roles,
      shutdownGraceMs: 20_000,
    });
    await writeManagedTask(root, boundary, marker, installedPnpmEntrypoint);
    const environmentOverrides = {
      PNPM_HOME: undefined,
      npm_config_store_dir: fixtureStore,
      npm_execpath: installedPnpmEntrypoint,
      ...boundary.environmentFor("parent"),
    };
    restoreEnvironment = overrideEnvironment(environmentOverrides);
    const cancellation = createControlledQgrCancellationSource();
    const captured = startCapturedQgrCommand(() => runQualityGateCommand({
      cancellationSource: cancellation,
      configPath: "architecture/foundation/quality-gates.yaml",
      consumerRoot: root,
      environment: process.env,
      executor: new PnpmQualityGateScriptExecutor({
        npmExecPath: installedPnpmEntrypoint,
      }),
      format: "json",
      profileId: "verify",
    }));
    let commandSettled = false;
    const commandResult = captured.result.then(
      (result) => {
        commandSettled = true;
        return result;
      },
      (error) => {
        commandSettled = true;
        throw error;
      },
    );
    execution = {
      result: commandResult,
      async stop() {
        if (!commandSettled) {
          cancellation.cancel();
        }
        await commandResult;
      },
    };
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
    let cliCompleted = false;
    const completion = execution.result.then((result) => {
      cliCompleted = true;
      return result;
    });
    cancellation.cancel();
    await boundary.assertStopped();
    assert.equal(cliCompleted, false, "owned roles must close before QGR accepts completion");
    const completed = await completion;
    assert.equal(completed.exitCode, 130);
    const report = JSON.parse(completed.stdout);
    assert.equal(report.outcome, "cancelled");
    assert.deepEqual(report.tasks.map(({ id, outcome }) => [id, outcome]), [
      ["slow", "cancelled"],
    ]);
  } finally {
    try {
      await cleanupSyntheticFixture({
        boundaries: [boundary],
        executions: [setupExecution, execution],
        roots: [root],
      });
    } finally {
      restoreEnvironment();
    }
  }
});
