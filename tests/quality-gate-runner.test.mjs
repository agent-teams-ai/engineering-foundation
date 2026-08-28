import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
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
  cleanupSyntheticFixture,
  createGenerationAwareChangeSignal,
  createSyntheticFixtureBoundary,
  observeFixtureEffect,
  startBoundedCli,
} from "./support/quality-gate-runner-lifecycle.mjs";

function policy(tasks, concurrency = 2) {
  return { packageManager: "pnpm", profiles: [{ id: "verify", concurrency, tasks }] };
}

function errorEvidence(error) {
  const evidence = [String(error?.message ?? error)];
  if (error?.cause !== undefined) {
    evidence.push(errorEvidence(error.cause));
  }
  if (Array.isArray(error?.errors)) {
    evidence.push(...error.errors.map((candidate) => errorEvidence(candidate)));
  }
  return evidence.flat(Infinity).join("\n");
}

async function openRawFixtureSocket(boundary) {
  const socket = createConnection({
    host: boundary.environment.QGR_FIXTURE_HOST,
    port: Number.parseInt(boundary.environment.QGR_FIXTURE_PORT, 10),
  });
  socket.on("error", () => {});
  await onceSocket(socket, "connect");
  return socket;
}

function onceSocket(socket, event) {
  return new Promise((resolve) => { socket.once(event, resolve); });
}

function readSocketLine(socket) {
  return new Promise((resolve, reject) => {
    let source = "";
    const onClose = () => { reject(new Error("Socket closed before a complete line.")); };
    const onData = (chunk) => {
      source += chunk;
      const newline = source.indexOf("\n");
      if (newline !== -1) {
        socket.off("close", onClose);
        socket.off("data", onData);
        resolve(source.slice(0, newline + 1));
      }
    };
    socket.once("close", onClose);
    socket.on("data", onData);
  });
}

async function registerRawFixtureRole(boundary, role) {
  const socket = await openRawFixtureSocket(boundary);
  socket.setEncoding("utf8");
  const acknowledged = readSocketLine(socket);
  const environment = boundary.environmentFor(role);
  socket.write(`${JSON.stringify({
    boundaryId: environment.QGR_FIXTURE_BOUNDARY_ID,
    credential: environment.QGR_FIXTURE_CREDENTIAL,
  })}\n`);
  assert.equal(
    await acknowledged,
    `${JSON.stringify({
      boundaryId: boundary.evidenceId,
      command: "registered",
      role,
    })}\n`,
  );
  return socket;
}

function createControlledDeadlines() {
  const registrations = new Map();
  const waiters = new Map();
  return {
    create(_milliseconds, label) {
      let expireDeadline;
      const record = {
        active: true,
        promise: new Promise((resolve) => { expireDeadline = resolve; }),
        expire: () => { expireDeadline(); },
      };
      registrations.set(label, record);
      waiters.get(label)?.();
      waiters.delete(label);
      return {
        cancel() { record.active = false; },
        promise: record.promise,
      };
    },
    expire(label) {
      const record = registrations.get(label);
      assert.equal(record?.active, true, `Expected active controlled deadline ${label}.`);
      record.expire();
    },
    waitFor(label) {
      if (registrations.has(label)) {
        return Promise.resolve();
      }
      return new Promise((resolve) => { waiters.set(label, resolve); });
    },
  };
}

function createNeverClosingChild() {
  const command = new EventEmitter();
  command.exitCode = null;
  command.signalCode = null;
  command.stderr = new PassThrough();
  command.stdout = new PassThrough();
  command.kill = (signal) => {
    if (signal === "SIGKILL") {
      command.exitCode = 0;
    }
    return true;
  };
  return command;
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

test("readiness polling succeeds when the sole watcher notification is dropped", async () => {
  let reads = 0;
  let unsubscribed = 0;
  const observation = observeFixtureEffect({
    pollIntervalMs: 5,
    async read() {
      reads += 1;
      if (reads === 1) {
        throw Object.assign(new Error("not ready"), { code: "ENOENT" });
      }
      return "poll-observed-ready-file";
    },
    subscribe() {
      return () => { unsubscribed += 1; };
    },
  });

  assert.equal(await observation.result, "poll-observed-ready-file");
  assert.equal(reads, 2);
  assert.equal(unsubscribed, 1);
});

test("change signals retain a notification between predicate evaluation and waiter registration", async () => {
  const changed = createGenerationAwareChangeSignal();
  const observedGeneration = changed.generation();
  assert.equal(false, false, "predicate evaluated false before the notification");
  changed.notify();
  assert.equal(await changed.wait(observedGeneration), observedGeneration + 1);
});

test("central cleanup starts owned roles together, bounds a stuck child, and still removes roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-cleanup-"));
  const marker = join(root, "exists-before-cleanup");
  const order = [];
  const deadlines = createControlledDeadlines();
  await writeFile(marker, "fixture", "utf8");
  const cleanup = cleanupSyntheticFixture({
    boundaries: [{ stop() { order.push("boundary"); throw new Error("boundary failed"); } }],
    createDeadline: deadlines.create,
    executions: [{ stop() { order.push("child"); return new Promise(() => {}); } }],
    roots: [root],
  });
  assert.deepEqual(order, ["child", "boundary"]);
  deadlines.expire("CLI child cleanup 1");
  await assert.rejects(
    cleanup,
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors.length, 2);
      assert.match(errorEvidence(error), /cleanup deadline/u);
      assert.match(errorEvidence(error), /boundary failed/u);
      return true;
    },
  );
  await assert.rejects(readFile(marker, "utf8"), (error) => error?.code === "ENOENT");
});

test("bounded CLI stop settles when the child never publishes stream close", async () => {
  const deadlines = createControlledDeadlines();
  const execution = startBoundedCli("unused.cjs", [], {
    createDeadline: deadlines.create,
    spawnChild: createNeverClosingChild,
  });
  const stopping = execution.stop();
  await deadlines.waitFor("Retained CLI close after SIGTERM");
  deadlines.expire("Retained CLI close after SIGTERM");
  await deadlines.waitFor("Retained CLI close after SIGKILL");
  deadlines.expire("Retained CLI close after SIGKILL");
  await deadlines.waitFor("Retained CLI final close");
  deadlines.expire("Retained CLI final close");
  await assert.rejects(stopping, (error) => {
    assert.match(errorEvidence(error), /did not close after forced shutdown/u);
    assert.match(errorEvidence(error), /final close exceeded/u);
    return true;
  });
});

test("bounded CLI watchdog starts containment before rejection and bounds cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-watchdog-"));
  const fixture = join(root, "retained.cjs");
  const deadlines = createControlledDeadlines();
  let execution;
  try {
    await writeFile(fixture, "setInterval(() => {}, 60000);\n", "utf8");
    let cleanupStarted = false;
    execution = startBoundedCli(fixture, [], {
      cleanupDeadlineMs: 1,
      createDeadline: deadlines.create,
      fixtureBoundary: {
        stop() {
          cleanupStarted = true;
          return new Promise(() => {});
        },
      },
      watchdogMs: 25,
    });
    let watchdogError;
    try {
      await execution.result;
      assert.fail("watchdog should reject");
    } catch (error) {
      watchdogError = error;
    }
    assert.match(watchdogError.message, /watchdog expired after 25ms/u);
    assert.equal(cleanupStarted, true, "containment must start before watchdog rejection is visible");
    await deadlines.waitFor("Watchdog containment cleanup");
    deadlines.expire("Watchdog containment cleanup");
    await watchdogError.cleanup;
    assert.equal(watchdogError.cleanupFailures.length, 1);
    assert.match(watchdogError.cleanupFailures[0].message, /cleanup deadline/u);
  } finally {
    await cleanupSyntheticFixture({ executions: [execution], roots: [root] });
  }
});

test("default child environments remove ambient QGR fixture authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-environment-"));
  const fixture = join(root, "environment.cjs");
  let execution;
  try {
    await writeFile(fixture, `process.stdout.write(JSON.stringify({
  fixtureKeys: Object.keys(process.env).filter((key) => key.startsWith("QGR_FIXTURE_")).sort(),
  unrelated: process.env.UNRELATED_FIXTURE_VALUE
}));\n`, "utf8");
    execution = startBoundedCli(fixture, [], {
      env: {
        ...process.env,
        QGR_FIXTURE_HOST: "ambient-host",
        QGR_FIXTURE_BOUNDARY_ID: "ambient-boundary",
        QGR_FIXTURE_CREDENTIAL: "ambient-credential",
        QGR_FIXTURE_NONCE: "ambient-nonce",
        QGR_FIXTURE_PORT: "1",
        QGR_FIXTURE_ROLE: "ambient-role",
        QGR_FIXTURE_UNRECOGNIZED: "ambient-extra",
        qgr_fixture_case_variant: "ambient-case-variant",
        UNRELATED_FIXTURE_VALUE: "preserved",
      },
    });
    const result = await execution.result;
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.stdout), { fixtureKeys: [], unrelated: "preserved" });
  } finally {
    await cleanupSyntheticFixture({ executions: [execution], roots: [root] });
  }
});

test("synthetic boundary rejects unauthenticated abuse and invalid role consumption", async () => {
  const cases = [
    {
      expected: /exceeded 32 bytes/u,
      options: { maximumRegistrationBytes: 32 },
      payload: "x".repeat(33),
    },
    {
      expected: /contained trailing data/u,
      payload: (boundary) => {
        const environment = boundary.environmentFor("owned");
        return `${JSON.stringify({
          boundaryId: environment.QGR_FIXTURE_BOUNDARY_ID,
          credential: environment.QGR_FIXTURE_CREDENTIAL,
        })}\nextra`;
      },
    },
    {
      expected: /must not claim a client-selected role/u,
      payload: (boundary) => {
        const environment = boundary.environmentFor("owned");
        return `${JSON.stringify({
          boundaryId: environment.QGR_FIXTURE_BOUNDARY_ID,
          credential: environment.QGR_FIXTURE_CREDENTIAL,
          role: "intruder",
        })}\n`;
      },
    },
    {
      expected: /invalid role credential/u,
      payload: (boundary) => `${JSON.stringify({
        boundaryId: boundary.evidenceId,
        credential: "not-server-assigned",
      })}\n`,
    },
  ];
  for (const candidate of cases) {
    const boundary = await createSyntheticFixtureBoundary({
      expectedRoles: ["owned"],
      shutdownGraceMs: 100,
      ...candidate.options,
    });
    const socket = await openRawFixtureSocket(boundary);
    const closed = onceSocket(socket, "close");
    socket.write(
      typeof candidate.payload === "function" ? candidate.payload(boundary) : candidate.payload,
    );
    await closed;
    await assert.rejects(boundary.stop(), (error) => {
      assert.match(errorEvidence(error), candidate.expected);
      return true;
    });
  }

  const dwellBoundary = await createSyntheticFixtureBoundary({
    expectedRoles: ["owned"],
    preAuthenticationDwellMs: 20,
    shutdownGraceMs: 100,
  });
  const dwellingSocket = await openRawFixtureSocket(dwellBoundary);
  await onceSocket(dwellingSocket, "close");
  await assert.rejects(dwellBoundary.stop(), (error) => {
    assert.match(errorEvidence(error), /registration exceeded 20ms/u);
    return true;
  });

  const abandonedBoundary = await createSyntheticFixtureBoundary({
    expectedRoles: ["owned"],
    shutdownGraceMs: 100,
  });
  const abandonedSocket = await openRawFixtureSocket(abandonedBoundary);
  const abandonedClose = onceSocket(abandonedSocket, "close");
  abandonedSocket.end();
  await abandonedClose;
  await assert.rejects(abandonedBoundary.stop(), (error) => {
    assert.match(errorEvidence(error), /closed before authentication/u);
    return true;
  });
});

test("synthetic boundary rejects duplicate execution and force-destroys retained sockets", async () => {
  const duplicateBoundary = await createSyntheticFixtureBoundary({
    expectedRoles: ["owned"],
    shutdownGraceMs: 100,
  });
  const first = await registerRawFixtureRole(duplicateBoundary, "owned");
  const firstClosed = onceSocket(first, "close");
  first.destroy();
  await firstClosed;
  const duplicate = await openRawFixtureSocket(duplicateBoundary);
  const duplicateClosed = onceSocket(duplicate, "close");
  const duplicateEnvironment = duplicateBoundary.environmentFor("owned");
  duplicate.write(`${JSON.stringify({
    boundaryId: duplicateEnvironment.QGR_FIXTURE_BOUNDARY_ID,
    credential: duplicateEnvironment.QGR_FIXTURE_CREDENTIAL,
  })}\n`);
  await duplicateClosed;
  await assert.rejects(duplicateBoundary.stop(), (error) => {
    assert.match(errorEvidence(error), /reused a consumed role credential/u);
    return true;
  });

  const retainedBoundary = await createSyntheticFixtureBoundary({
    expectedRoles: ["retained"],
    shutdownGraceMs: 30,
  });
  const retained = await registerRawFixtureRole(retainedBoundary, "retained");
  const retainedClosed = onceSocket(retained, "close");
  await assert.rejects(retainedBoundary.stop(), (error) => {
    assert.match(errorEvidence(error), /Timed out waiting/u);
    return true;
  });
  await retainedClosed;
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
    await cleanupSyntheticFixture({ roots: [root] });
  }
});
