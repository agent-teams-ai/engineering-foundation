import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assert as assertProperty, integer, property } from "fast-check";

import { PackageScriptTimeoutError } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/application/ports/package-script-executor.js";
import { FilesystemPackageScriptCatalogReader } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/outbound/filesystem/filesystem-package-script-catalog-reader.js";
import { PnpmQualityGateScriptExecutor } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/outbound/pnpm/pnpm-package-script-executor.js";
import {
  QualityGateGraphError,
  validateQualityGatePolicy,
} from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/application/policies/validate-quality-gate-graph.js";
import { runQualityGateProfile } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/application/use-cases/run-quality-gate-profile.js";
import {
  createSyntheticFixtureBoundary,
  observeFixtureEffect,
  removeFixtureRoot,
  startBoundedCli,
  waitForFixtureEffect,
  writeFixtureBoundaryClient,
} from "./support/quality-gate-runner-lifecycle.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repositoryRoot, "packages", "engineering-foundation", "dist", "cli.js");

function policy(tasks, concurrency = 2) {
  return { packageManager: "pnpm", profiles: [{ id: "verify", concurrency, tasks }] };
}

function startCli(arguments_, options = {}) {
  return startBoundedCli(cliPath, arguments_, options);
}

async function writeFixturePnpm(root) {
  await writeFixtureBoundaryClient(root);
  const entrypoint = join(root, "fixture-pnpm.cjs");
  await writeFile(entrypoint, `const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { readFileSync } = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { connect } = require("./fixture-boundary-client.cjs");

void (async () => {
let task;
await connect("package-manager", async () => {
  if (task === undefined || task.exitCode !== null || task.signalCode !== null) return;
  task.kill("SIGTERM");
  const closed = await Promise.race([once(task, "close").then(() => true), delay(1000, false)]);
  if (!closed && task.exitCode === null && task.signalCode === null) task.kill("SIGKILL");
  if (!closed) await once(task, "close");
});
if (process.argv.length !== 4 || process.argv[2] !== "run") {
  throw new Error("Unexpected fixture pnpm arguments: " + JSON.stringify(process.argv.slice(2)));
}
const script = JSON.parse(readFileSync("package.json", "utf8")).scripts[process.argv[3]];
const match = /^node ([a-z0-9.-]+\\.cjs)$/u.exec(script);
if (match === null) {
  throw new Error("Fixture pnpm accepts only a single local Node script.");
}
task = spawn(process.execPath, [match[1]], {
  stdio: "inherit"
});
const [code] = await once(task, "exit");
process.exit(code ?? 1);
})().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exit(1);
});
`, "utf8");
  return entrypoint;
}

async function writeNeverEndingTaskFixture(root, filename, effectPath) {
  await writeFixtureBoundaryClient(root);
  const descendantSource = `const { connect } = require("./fixture-boundary-client.cjs");
void (async () => {
  await connect("descendant");
  process.send?.("ready");
  setInterval(() => {}, 60000);
})().catch((error) => { throw error; });
`;
  await writeFile(join(root, filename), `const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { renameSync, writeFileSync } = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { connect } = require("./fixture-boundary-client.cjs");

void (async () => {
let descendant;
await connect("parent", async () => {
  if (descendant === undefined || descendant.exitCode !== null || descendant.signalCode !== null) return;
  descendant.kill("SIGTERM");
  const closed = await Promise.race([once(descendant, "close").then(() => true), delay(1000, false)]);
  if (!closed && descendant.exitCode === null && descendant.signalCode === null) descendant.kill("SIGKILL");
  if (!closed) await once(descendant, "close");
});
descendant = spawn(process.execPath, ["--eval", ${JSON.stringify(descendantSource)}], {
  stdio: ["ignore", "ignore", "ignore", "ipc"]
});
await once(descendant, "message");
const temporary = ${JSON.stringify(effectPath)} + "." + process.env.QGR_FIXTURE_NONCE + ".tmp";
writeFileSync(temporary, JSON.stringify({
  nonce: process.env.QGR_FIXTURE_NONCE,
  roles: ["package-manager", "parent", "descendant"]
}) + "\\n");
renameSync(temporary, ${JSON.stringify(effectPath)});
setInterval(() => {}, 60000);
})().catch((error) => { throw error; });
`, "utf8");
}

function parseOwnedReadiness(boundary, roles) {
  return (source) => {
    const record = JSON.parse(source);
    assert.deepEqual(record, { nonce: boundary.nonce, roles });
    return record;
  };
}

test("rejects duplicate, unknown, self, overlapping, and cyclic dependencies", () => {
  const invalid = [
    policy([{ id: "a", needs: [], after: [] }, { id: "a", needs: [], after: [] }]),
    policy([{ id: "a", needs: ["missing"], after: [] }]),
    policy([{ id: "a", needs: ["a"], after: [] }]),
    policy([{ id: "a", needs: [], after: [] }, { id: "b", needs: ["a"], after: ["a"] }]),
    policy([{ id: "a", needs: ["b"], after: [] }, { id: "b", needs: [], after: ["a"] }]),
  ];
  for (const candidate of invalid) {
    assert.throws(() => validateQualityGatePolicy(candidate), QualityGateGraphError);
  }
});

test("accepts generated DAGs regardless of dependency density", () => {
  assertProperty(
    property(integer({ min: 1, max: 48 }), integer({ min: 0, max: 7 }), (size, divisor) => {
      const tasks = Array.from({ length: size }, (_, index) => ({
        id: `t${index}`,
        needs: Array.from({ length: index }, (_unused, dependency) => dependency)
          .filter((dependency) => (dependency + index) % (divisor + 2) === 0)
          .map((dependency) => `t${dependency}`),
        after: [],
      }));
      assert.doesNotThrow(() => validateQualityGatePolicy(policy(tasks)));
    }),
    { numRuns: 200, seed: 42 },
  );
});

test("schedules needs and after with bounded concurrency and deterministic report order", async () => {
  let active = 0;
  let maximumActive = 0;
  const starts = [];
  const executor = {
    async run({ scriptId }) {
      starts.push(scriptId);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => { setTimeout(resolve, scriptId === "a" ? 15 : 1); });
      active -= 1;
      return {
        exitCode: scriptId === "a" ? 7 : 0,
        signal: null,
        stdout: scriptId === "a" ? `old\n${"x".repeat(9000)}\u001b]52;c;unsafe\u0007` : "",
        stderr: scriptId === "a" ? "begin\rfailure-end" : "",
      };
    },
  };
  const report = await runQualityGateProfile({
    consumerRoot: "/fixture",
    profile: policy([
      { id: "a", needs: [], after: [] },
      { id: "parallel", needs: [], after: [] },
      { id: "blocked", needs: ["a"], after: [] },
      { id: "cleanup", needs: [], after: ["a"] },
    ], 2).profiles[0],
  }, executor, { nowMs: () => performance.now() });

  assert.equal(maximumActive, 2);
  assert.deepEqual(starts, ["a", "parallel", "cleanup"]);
  assert.deepEqual(report.tasks.map(({ id, outcome }) => [id, outcome]), [
    ["a", "failed"],
    ["parallel", "passed"],
    ["blocked", "blocked"],
    ["cleanup", "passed"],
  ]);
  assert.equal(report.tasks[0].failureTail.length <= 8192, true);
  assert.match(report.tasks[0].failureTail, /failure-end$/u);
  assert.match(report.tasks[0].failureTail, /\\u\{001b\}/u);
  assert.match(report.tasks[0].failureTail, /\\u\{000d\}/u);
  assert.equal([...report.tasks[0].failureTail].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x08 ||
      (codePoint >= 0x0b && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f);
  }), false);
});

test("classifies timeout and cancellation without starting dependent tasks", async () => {
  const timeoutReport = await runQualityGateProfile({
    consumerRoot: "/fixture",
    profile: policy([
      { id: "slow", needs: [], after: [], timeoutMs: 5 },
      { id: "dependent", needs: ["slow"], after: [] },
    ]).profiles[0],
  }, {
    async run() { throw new PackageScriptTimeoutError(5); },
  }, { nowMs: () => 1 });
  assert.deepEqual(timeoutReport.tasks.map(({ outcome }) => outcome), ["timed-out", "blocked"]);

  const controller = new AbortController();
  const cancellation = runQualityGateProfile({
    consumerRoot: "/fixture",
    profile: policy([{ id: "slow", needs: [], after: [] }]).profiles[0],
    signal: controller.signal,
  }, {
    run: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }),
  }, { nowMs: () => 1 });
  controller.abort();
  assert.equal((await cancellation).outcome, "cancelled");

  const adapterFailure = await runQualityGateProfile({
    consumerRoot: "/fixture",
    profile: policy([{ id: "broken", needs: [], after: [] }]).profiles[0],
  }, {
    async run() { throw new Error("unsafe\u001b]52;c;payload\u0007"); },
  }, { nowMs: () => 1 });
  assert.equal(adapterFailure.tasks[0].outcome, "failed");
  assert.equal(adapterFailure.tasks[0].failureTail, "unsafe\\u{001b}]52;c;payload\\u{0007}");
});

test("package catalog cancellation keeps the stable cancelled outcome", async () => {
  const controller = new AbortController();
  controller.abort("test cancellation");
  await assert.rejects(
    new FilesystemPackageScriptCatalogReader().read("/not-read", controller.signal),
    (error) => error?.problem?.code === "EXECUTION_CANCELLED",
  );
});

test("readiness retries the ENOENT read when an atomic rename overlaps it", async () => {
  let notify;
  let releaseFirstRead;
  let reportFirstRead;
  let reads = 0;
  let unsubscribed = 0;
  const firstRead = new Promise((resolve) => { reportFirstRead = resolve; });
  const overlap = new Promise((resolve) => { releaseFirstRead = resolve; });
  const observation = observeFixtureEffect({
    async read() {
      reads += 1;
      if (reads === 1) {
        reportFirstRead();
        await overlap;
        throw Object.assign(new Error("read began before atomic rename"), { code: "ENOENT" });
      }
      return "renamed-ready-file";
    },
    subscribe(onChange) {
      notify = onChange;
      return () => { unsubscribed += 1; };
    },
  });

  await firstRead;
  notify();
  releaseFirstRead();
  assert.equal(await observation.result, "renamed-ready-file");
  assert.equal(reads, 2);
  assert.equal(unsubscribed, 1);
});

test("resolves pnpm entrypoints from focused environment candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-resolver-"));
  try {
    const cases = [
      {
        name: "npm_execpath JavaScript entrypoint",
        async prepare(marker) {
          const entrypoint = join(root, "npm-exec-probe.cjs");
          await writeFile(
            entrypoint,
            `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
            "utf8",
          );
          return { environment: { npmExecPath: entrypoint }, expected: ["run", "probe"] };
        },
      },
      {
        name: "PNPM_HOME package entrypoint",
        async prepare(marker) {
          const pnpmHome = join(root, "pnpm-home", ".tools");
          const entrypoint = join(root, "pnpm-home", "pnpm", "bin", "pnpm.cjs");
          await mkdir(dirname(entrypoint), { recursive: true });
          await writeFile(
            entrypoint,
            `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
            "utf8",
          );
          return { environment: { pnpmHome }, expected: ["run", "probe"] };
        },
      },
      ...(process.platform === "win32" ? [
        {
          name: "PNPM_HOME Windows executable",
          async prepare(marker) {
            const pnpmHome = join(root, "windows-pnpm-home");
            await mkdir(pnpmHome, { recursive: true });
            await copyFile(process.execPath, join(pnpmHome, "pnpm.exe"));
            await writeFile(
              join(root, "run"),
              `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
              "utf8",
            );
            return { environment: { pnpmHome }, expected: ["probe"] };
          },
        },
        {
          name: "PATH Windows executable",
          async prepare(marker) {
            const pathRoot = join(root, "windows-path");
            await mkdir(pathRoot, { recursive: true });
            await copyFile(process.execPath, join(pathRoot, "pnpm.exe"));
            await writeFile(
              join(root, "run"),
              `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
              "utf8",
            );
            return {
              environment: { pathValue: `${join(root, "missing")}${delimiter}${pathRoot}` },
              expected: ["probe"],
            };
          },
        },
      ] : [
        {
          name: "PATH JavaScript entrypoint",
          async prepare(marker) {
            const pathRoot = join(root, "posix-path");
            const entrypoint = join(root, "path-probe.cjs");
            await mkdir(pathRoot, { recursive: true });
            await writeFile(
              entrypoint,
              `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
              "utf8",
            );
            await symlink(entrypoint, join(pathRoot, "pnpm"));
            return {
              environment: { pathValue: `${join(root, "missing")}${delimiter}${pathRoot}` },
              expected: ["run", "probe"],
            };
          },
        },
      ]),
    ];

    for (const [index, candidate] of cases.entries()) {
      const marker = join(root, `resolver-${index}.json`);
      const { environment, expected } = await candidate.prepare(marker);
      const result = await new PnpmQualityGateScriptExecutor(environment).run({
        consumerRoot: root,
        scriptId: "probe",
        timeoutMs: 10_000,
      });
      assert.equal(result.exitCode, 0, `${candidate.name}: ${JSON.stringify(result)}`);
      assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), expected, candidate.name);
    }
  } finally {
    await removeFixtureRoot(root);
  }
});

async function writeConsumer(root, profileSource, scripts, packageManagerVersion = "11.20.0") {
  await mkdir(join(root, "architecture", "foundation"), { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "quality-gate-test-consumer",
    private: true,
    packageManager: `pnpm@${packageManagerVersion}`,
    scripts,
  }, null, 2)}\n`, "utf8");
  await writeFile(join(root, "foundation.config.yaml"), `schemaVersion: 1
project:
  id: quality-gate-test
capabilities:
  quality.gate-runner:
    configPath: architecture/foundation/quality-gates.yaml
`, "utf8");
  await writeFile(join(root, "architecture", "foundation", "quality-gates.yaml"), profileSource, "utf8");
}

test("CLI runs a bounded synthetic consumer through the installed pnpm", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-real-pnpm-"));
  const marker = join(root, ".real-pnpm-smoke.json");
  let boundary;
  let execution;
  try {
    assert.equal(
      typeof process.env.npm_execpath,
      "string",
      "Run this test through the installed pnpm so npm_execpath identifies the real entrypoint.",
    );
    const installedVersion = /^pnpm\/(?<version>\d+\.\d+\.\d+)\b/u.exec(
      process.env.npm_config_user_agent ?? "",
    )?.groups?.version;
    assert.notEqual(installedVersion, undefined, "Installed pnpm did not report its exact version.");
    boundary = await createSyntheticFixtureBoundary();
    await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: smoke
        timeoutMs: 30000
`, {
      smoke: "node real-pnpm-smoke.cjs",
    }, installedVersion);
    await writeFixtureBoundaryClient(root);
    await writeFile(join(root, "real-pnpm-smoke.cjs"), `const { connect } = require("./fixture-boundary-client.cjs");
void (async () => {
  await connect("real-pnpm-task");
  require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
    nonce: process.env.QGR_FIXTURE_NONCE,
    packageManager: "pnpm"
  }) + "\\n");
  process.exit(0);
})().catch((error) => { throw error; });
`, "utf8");
    execution = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], {
      env: {
        ...process.env,
        ...boundary.environment,
        npm_execpath: process.env.npm_execpath,
      },
      fixtureBoundary: boundary,
    });
    const result = await execution.result;
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.equal(JSON.parse(result.stdout).outcome, "passed");
    await boundary.waitForRoles(["real-pnpm-task"]);
    await boundary.assertStopped(["real-pnpm-task"]);
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), {
      nonce: boundary.nonce,
      packageManager: "pnpm",
    });
  } finally {
    await execution?.stop();
    await boundary?.stop();
    await removeFixtureRoot(root);
  }
});

test("CLI preserves a failing script exit code and emits versioned JSON evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-cli-"));
  try {
    await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: fail
`, {
      fail: "node failure-fixture.cjs",
    });
    await writeFile(
      join(root, "failure-fixture.cjs"),
      "process.stderr.write('failure-tail'); process.exit(7);\n",
      "utf8",
    );
    const fixturePnpm = await writeFixturePnpm(root);
    const { result } = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], { env: { ...process.env, npm_execpath: fixturePnpm } });
    const completed = await result;
    assert.equal(completed.status, 7, JSON.stringify(completed));
    const report = JSON.parse(completed.stdout);
    assert.equal(report.reportSchemaVersion, 1);
    assert.equal(report.outcome, "failed");
    assert.equal(report.tasks[0].exitCode, 7);
    assert.match(report.tasks[0].failureTail, /failure-tail$/u);
  } finally {
    await removeFixtureRoot(root);
  }
});

test("static capability check validates an opted-in profile without running scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-static-"));
  const marker = join(root, "must-not-exist");
  try {
    await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: guarded
`, {
      guarded: `node --eval "require('node:fs').writeFileSync('${marker}', '')"`,
    });
    const { result } = startCli([
      "check", "quality.gate-runner", "--consumer", root, "--format", "json",
    ]);
    const completed = await result;
    assert.equal(completed.status, 0, JSON.stringify(completed));
    assert.equal(JSON.parse(completed.stdout).outcome, "passed");
    assert.equal(await import("node:fs").then(({ existsSync }) => existsSync(marker)), false);
  } finally {
    await removeFixtureRoot(root);
  }
});

test("CLI rejects missing scripts, recursion, invalid timeout, and cycles before execution", async () => {
  const cases = [
    {
      source: "      - id: missing\n",
      scripts: {},
      expected: "QUALITY_GATE_SCRIPTS_INVALID",
    },
    {
      source: "      - id: recursive\n",
      scripts: { recursive: "agent-teams-foundation gate run verify" },
      expected: "QUALITY_GATE_SCRIPTS_INVALID",
    },
    {
      source: "      - id: pass\n        timeoutMs: 0\n",
      scripts: { pass: "node --version" },
      expected: "SCHEMA_INVALID",
    },
    {
      source: "      - id: one\n        needs: [two]\n      - id: two\n        needs: [one]\n",
      scripts: { one: "node --version", two: "node --version" },
      expected: "QUALITY_GATE_RUNNER_CONFIG_INVALID",
    },
  ];
  for (const [index, candidate] of cases.entries()) {
    const root = await mkdtemp(join(tmpdir(), `foundation-quality-gate-invalid-${index}-`));
    try {
      await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
${candidate.source}`, candidate.scripts);
      const { result } = startCli([
        "gate", "run", "verify", "--consumer", root,
      ]);
      const completed = await result;
      assert.equal(completed.status, 2);
      assert.match(completed.stderr, new RegExp(`^${candidate.expected}:`, "u"));
    } finally {
      await removeFixtureRoot(root);
    }
  }
});

test("CLI enforces a real per-task timeout and returns 124", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-timeout-"));
  const effectPath = join(root, ".timeout-readiness.json");
  const roles = ["package-manager", "parent", "descendant"];
  let boundary;
  let execution;
  try {
    boundary = await createSyntheticFixtureBoundary();
    await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: slow
        timeoutMs: 10000
`, {
      slow: "node timeout-fixture.cjs",
    });
    await writeNeverEndingTaskFixture(root, "timeout-fixture.cjs", effectPath);
    const fixturePnpm = await writeFixturePnpm(root);
    execution = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], {
      env: {
        ...process.env,
        ...boundary.environment,
        npm_execpath: fixturePnpm,
      },
      fixtureBoundary: boundary,
    });
    await waitForFixtureEffect(effectPath, execution, parseOwnedReadiness(boundary, roles));
    await boundary.waitForRoles(roles);
    const result = await execution.result;
    assert.equal(result.status, 124, JSON.stringify(result));
    assert.equal(JSON.parse(result.stdout).tasks[0].outcome, "timed-out");
    await boundary.assertStopped(roles);
  } finally {
    await execution?.stop();
    await boundary?.stop();
    await removeFixtureRoot(root);
  }
});

test("readiness failure cleans up and awaits the nonce-owned fixture boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-readiness-failure-"));
  const effectPath = join(root, ".invalid-readiness.json");
  const roles = ["package-manager", "parent", "descendant"];
  let boundary;
  let execution;
  try {
    boundary = await createSyntheticFixtureBoundary();
    await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: slow
        timeoutMs: 60000
`, {
      slow: "node readiness-failure-fixture.cjs",
    });
    await writeNeverEndingTaskFixture(root, "readiness-failure-fixture.cjs", effectPath);
    const fixturePnpm = await writeFixturePnpm(root);
    execution = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], {
      env: {
        ...process.env,
        ...boundary.environment,
        npm_execpath: fixturePnpm,
      },
      fixtureBoundary: boundary,
    });
    await assert.rejects(
      waitForFixtureEffect(effectPath, execution, (source) => {
        const record = JSON.parse(source);
        assert.equal(record.nonce, "intentionally-not-owned", "readiness nonce mismatch");
      }),
      /readiness nonce mismatch/u,
    );
    await boundary.waitForRoles(roles);
    await execution.stop();
    await boundary.assertStopped(roles);
  } finally {
    await execution?.stop();
    await boundary?.stop();
    await removeFixtureRoot(root);
  }
});

test("runtime marker rejects dynamically assembled recursive gate commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-recursion-"));
  const effectPath = join(root, ".recursion-readiness.json");
  const roles = ["package-manager", "recursion"];
  let boundary;
  let execution;
  try {
    boundary = await createSyntheticFixtureBoundary();
    await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: dynamic
`, {
      dynamic: "node recursion-fixture.cjs",
    });
    await writeFile(join(root, "recursion-fixture.cjs"), `const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { renameSync, writeFileSync } = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { connect } = require("./fixture-boundary-client.cjs");

void (async () => {
let nested;
await connect("recursion", async () => {
  if (nested === undefined || nested.exitCode !== null || nested.signalCode !== null) return;
  nested.kill("SIGTERM");
  const closed = await Promise.race([once(nested, "close").then(() => true), delay(1000, false)]);
  if (!closed && nested.exitCode === null && nested.signalCode === null) nested.kill("SIGKILL");
  if (!closed) await once(nested, "close");
});
const temporary = ${JSON.stringify(effectPath)} + "." + process.env.QGR_FIXTURE_NONCE + ".tmp";
writeFileSync(temporary, JSON.stringify({
  nonce: process.env.QGR_FIXTURE_NONCE,
  roles: ["package-manager", "recursion"]
}) + "\\n");
renameSync(temporary, ${JSON.stringify(effectPath)});
nested = spawn(process.execPath, [
  process.env.GATE_CLI, "gate", "run", "verify", "--consumer", process.cwd()
], { stdio: "inherit" });
const [code] = await once(nested, "exit");
process.exit(code ?? 1);
})().catch((error) => { throw error; });
`, "utf8");
    const fixturePnpm = await writeFixturePnpm(root);
    execution = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], {
      env: {
        ...process.env,
        ...boundary.environment,
        GATE_CLI: cliPath,
        npm_execpath: fixturePnpm,
      },
      fixtureBoundary: boundary,
    });
    await waitForFixtureEffect(effectPath, execution, parseOwnedReadiness(boundary, roles));
    await boundary.waitForRoles(roles);
    const result = await execution.result;
    assert.equal(result.status, 2, JSON.stringify(result));
    const report = JSON.parse(result.stdout);
    assert.equal(report.tasks[0].outcome, "failed");
    assert.match(report.tasks[0].failureTail, /QUALITY_GATE_RECURSION/u);
    await boundary.assertStopped(roles);
  } finally {
    await execution?.stop();
    await boundary?.stop();
    await removeFixtureRoot(root);
  }
});

test("SIGTERM cancels an active gate with the documented exit code", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-sigterm-"));
  const effectPath = join(root, ".cancellation-readiness.json");
  const roles = ["package-manager", "parent", "descendant"];
  let boundary;
  let execution;
  try {
    boundary = await createSyntheticFixtureBoundary();
    await writeConsumer(root, `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: verify
    concurrency: 1
    tasks:
      - id: slow
`, {
      slow: "node cancellation-fixture.cjs",
    });
    await writeNeverEndingTaskFixture(root, "cancellation-fixture.cjs", effectPath);
    const fixturePnpm = await writeFixturePnpm(root);
    execution = startCli([
      "gate", "run", "verify", "--consumer", root, "--format", "json",
    ], {
      env: {
        ...process.env,
        ...boundary.environment,
        npm_execpath: fixturePnpm,
      },
      fixtureBoundary: boundary,
    });
    await waitForFixtureEffect(effectPath, execution, parseOwnedReadiness(boundary, roles));
    await boundary.waitForRoles(roles);
    assert.equal(execution.command.kill("SIGTERM"), true);
    const result = await execution.result;
    assert.deepEqual(
      { code: result.status, signal: result.signal },
      { code: 143, signal: null },
    );
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "cancelled");
    assert.equal(report.tasks[0].outcome, "cancelled");
    await boundary.assertStopped(roles);
  } finally {
    await execution?.stop();
    await boundary?.stop();
    await removeFixtureRoot(root);
  }
});
