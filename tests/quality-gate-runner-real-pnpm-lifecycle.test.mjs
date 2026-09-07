import { createManagedProcessExecutor } from "./support/capability-adapters.mjs";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import test from "node:test";

import { PnpmQualityGateScriptExecutor } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/outbound/pnpm/pnpm-package-script-executor.js";
import {
  awaitQgrSetupBeforeTransfer,
  cleanupSyntheticFixture,
  createControlledQgrCancellationSource,
  createSyntheticFixtureBoundary,
  startBoundedCli,
  startInjectedQgrCliCommand,
  waitForFixtureEffect,
  writeFixtureBoundaryClient,
} from "./support/quality-gate-runner-lifecycle.mjs";

const roles = ["parent", "descendant"];
const noOp = () => {};
const fixtureEnvironmentPattern = /^QGR_FIXTURE_/iu;
const javaScriptEntrypointPattern = /\.(?:c|m)?js$/iu;
const windowsShellEntrypointPattern = /\.(?:bat|cmd|ps1)$/iu;
const defaultWindowsExecutableExtensions = ".COM;.EXE;.BAT;.CMD";

function environmentValue(environment, name) {
  const exactValue = environment[name];
  if (exactValue !== undefined) {
    return exactValue;
  }
  const matchingKey = Object.keys(environment).find(
    (key) => key.toUpperCase() === name,
  );
  return matchingKey === undefined ? undefined : environment[matchingKey];
}

function commandNames(command, environment) {
  if (process.platform !== "win32" || extname(command) !== "") {
    return [command];
  }
  const pathExt = environmentValue(environment, "PATHEXT") ??
    defaultWindowsExecutableExtensions;
  const extensions = pathExt
    .split(delimiter)
    .filter((extension) => extension !== "")
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  return [command, ...extensions.map((extension) => `${command}${extension}`)];
}

function pathDirectory(segment) {
  if (segment === "") {
    return process.cwd();
  }
  if (
    process.platform === "win32" &&
    segment.length >= 2 &&
    segment.startsWith('"') &&
    segment.endsWith('"')
  ) {
    return segment.slice(1, -1);
  }
  return segment;
}

async function canonicalExecutable(candidate) {
  try {
    const candidateStat = await stat(candidate);
    if (!candidateStat.isFile()) {
      return null;
    }
    await access(candidate, constants.X_OK);
    const canonical = await realpath(candidate);
    if (
      process.platform === "win32" &&
      windowsShellEntrypointPattern.test(canonical)
    ) {
      return null;
    }
    return canonical;
  } catch (error) {
    if (["EACCES", "ENOENT", "ENOTDIR"].includes(error?.code)) {
      return null;
    }
    throw error;
  }
}

async function resolveCommand(command, environment = process.env) {
  const path = environmentValue(environment, "PATH");
  assert.equal(
    typeof path,
    "string",
    `Cannot resolve ${JSON.stringify(command)} without PATH.`,
  );
  for (const segment of path.split(delimiter)) {
    const directory = pathDirectory(segment);
    for (const name of commandNames(command, environment)) {
      const executable = await canonicalExecutable(resolve(directory, name));
      if (executable !== null) {
        return executable;
      }
    }
  }
  assert.fail(`Could not resolve ${JSON.stringify(command)} through PATH.`);
}

function fixtureEnvironmentSnapshot(environment = process.env) {
  return new Map(
    Object.entries(environment).filter(([key]) => fixtureEnvironmentPattern.test(key)),
  );
}

function restoreFixtureEnvironment(environment, snapshot) {
  for (const key of Object.keys(environment)) {
    if (fixtureEnvironmentPattern.test(key)) {
      delete environment[key];
    }
  }
  for (const [key, value] of snapshot) {
    environment[key] = value;
  }
}

function installOneUseFixtureAuthority(environment, authority) {
  const snapshot = fixtureEnvironmentSnapshot(environment);
  restoreFixtureEnvironment(environment, new Map());
  Object.assign(environment, authority);
  let restored = false;
  return () => {
    if (restored) {
      return;
    }
    restored = true;
    restoreFixtureEnvironment(environment, snapshot);
  };
}

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
  assert.notEqual(process.env.npm_execpath, "", "Installed pnpm reported an empty entrypoint.");
  const entrypoint = basename(process.env.npm_execpath) === process.env.npm_execpath
    ? await resolveCommand(process.env.npm_execpath)
    : await realpath(process.env.npm_execpath);
  const nodeEntrypoint = javaScriptEntrypointPattern.test(entrypoint);
  assert.equal(
    process.platform === "win32" &&
      !nodeEntrypoint &&
      windowsShellEntrypointPattern.test(entrypoint),
    false,
    "Installed pnpm resolved to a shell entrypoint instead of JavaScript or a native executable.",
  );
  return {
    entrypoint,
    nodeEntrypoint,
    version,
  };
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
const { accessSync, constants, realpathSync, renameSync, statSync, writeFileSync } = require("node:fs");
const { basename, delimiter, extname, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { connect } = require("./fixture-boundary-client.cjs");

const environmentValue = (name) => {
  const exactValue = process.env[name];
  if (exactValue !== undefined) return exactValue;
  const matchingKey = Object.keys(process.env).find((key) => key.toUpperCase() === name);
  return matchingKey === undefined ? undefined : process.env[matchingKey];
};
const canonicalizeNpmExecPath = (entrypoint) => {
  if (typeof entrypoint !== "string" || entrypoint === "") {
    throw new Error("Installed pnpm child did not report npm_execpath.");
  }
  const canonicalExecutable = (candidate) => {
    const canonical = realpathSync(candidate);
    if (process.platform === "win32" && /\\.(?:bat|cmd|ps1)$/iu.test(canonical)) {
      return undefined;
    }
    return canonical;
  };
  if (basename(entrypoint) !== entrypoint) {
    const canonical = canonicalExecutable(entrypoint);
    if (canonical !== undefined) return canonical;
    throw new Error("Installed pnpm child resolved to a shell entrypoint.");
  }
  const path = environmentValue("PATH");
  if (typeof path !== "string") {
    throw new Error("Installed pnpm child reported a command name without PATH.");
  }
  const pathExt = environmentValue("PATHEXT") ?? ${JSON.stringify(defaultWindowsExecutableExtensions)};
  const extensions = process.platform === "win32" && extname(entrypoint) === ""
    ? ["", ...pathExt.split(delimiter).filter((extension) => extension !== "")]
    : [""];
  for (const segment of path.split(delimiter)) {
    const unquoted = process.platform === "win32" && segment.length >= 2 &&
      segment.startsWith('"') && segment.endsWith('"')
      ? segment.slice(1, -1)
      : segment;
    const directory = unquoted === "" ? process.cwd() : unquoted;
    for (const extension of extensions) {
      const suffix = extension === "" || extension.startsWith(".") ? extension : "." + extension;
      const candidate = resolve(directory, entrypoint + suffix);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        const canonical = canonicalExecutable(candidate);
        if (canonical !== undefined) return canonical;
      } catch (error) {
        if (["EACCES", "ENOENT", "ENOTDIR"].includes(error?.code)) continue;
        throw error;
      }
    }
  }
  throw new Error("Installed pnpm child command could not be resolved through PATH.");
};

void (async () => {
if (process.env.npm_lifecycle_event !== "slow") {
  throw new Error("Installed pnpm did not set npm_lifecycle_event=slow.");
}
const canonicalNpmExecPath = canonicalizeNpmExecPath(process.env.npm_execpath);
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
const readinessPath = ${JSON.stringify(marker)} + ".tmp";
writeFileSync(readinessPath, JSON.stringify({
  evidenceId: process.env.QGR_FIXTURE_BOUNDARY_ID,
  lifecycleEvent: process.env.npm_lifecycle_event,
  npmExecPath: canonicalNpmExecPath,
  roles: ${JSON.stringify(roles)}
}) + "\\n", { flag: "wx" });
renameSync(readinessPath, ${JSON.stringify(marker)});
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
    nodeEntrypoint: installed.nodeEntrypoint,
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
  let restoreFixtureAuthority = noOp;
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
    };
    restoreEnvironment = overrideEnvironment(environmentOverrides);
    restoreFixtureAuthority = installOneUseFixtureAuthority(
      process.env,
      boundary.environmentFor("parent"),
    );
    const cancellation = createControlledQgrCancellationSource();
    const captured = startInjectedQgrCliCommand({
      cancellationSource: cancellation,
      consumerRoot: root,
      environment: process.env,
      executor: new PnpmQualityGateScriptExecutor({
        childEnvironment: Object.freeze({
          ...process.env,
          AGENT_TEAMS_FOUNDATION_QUALITY_GATE_ACTIVE: "verify",
        }),
        npmExecPath: installedPnpmEntrypoint,
        pathValue: dirname(installedPnpmEntrypoint),
      }, createManagedProcessExecutor()),
      projectId: "quality-gate-real-pnpm-lifecycle",
    });
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
      restoreFixtureAuthority();
      restoreEnvironment();
    }
  }
});

test("real-pnpm fixture authority replaces mixed-case ambient entries and restores them exactly", () => {
  const original = fixtureEnvironmentSnapshot();
  try {
    restoreFixtureEnvironment(process.env, new Map([
      ["QgR_FiXtUrE_Ambient", "mixed-case-ambient"],
      ["qgr_fixture_case_variant", "lower-case-ambient"],
    ]));
    const ambient = fixtureEnvironmentSnapshot();
    const authority = {
      QGR_FIXTURE_BOUNDARY_ID: "one-use-boundary",
      QGR_FIXTURE_CREDENTIAL: "one-use-credential",
      QGR_FIXTURE_HOST: "127.0.0.1",
      QGR_FIXTURE_PORT: "12345",
      QGR_FIXTURE_ROLE: "parent",
    };
    const restore = installOneUseFixtureAuthority(process.env, authority);
    assert.deepEqual(fixtureEnvironmentSnapshot(), new Map(Object.entries(authority)));
    process.env.qGr_Fixture_Injected = "must-not-survive";
    restore();
    assert.deepEqual(fixtureEnvironmentSnapshot(), ambient);
  } finally {
    restoreFixtureEnvironment(process.env, original);
  }
});
