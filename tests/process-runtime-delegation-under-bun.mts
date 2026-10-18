import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { ProcessCancellationError, ProcessTimeoutError, type ManagedProcessResult } from "../packages/engineering-foundation/dist/process-execution/api.js";
import { NodeProcessRunner, executeManagedProcess } from "../packages/engineering-foundation/dist/process-execution/node-process-runner.js";
import { readProcessFailureFacts } from "../packages/engineering-foundation/dist/features/validation-reporting/process-failure-facts.js";
import { NODE_EXECUTABLE_ENVIRONMENT_VARIABLE, requireAdmittedNodeExecutable } from "../packages/engineering-foundation/dist/process-execution/node-runtime-verifier.js";

const explicitNode = process.env["PROCESS_RUNTIME_DELEGATION_NODE"];
if (typeof explicitNode !== "string") {
  throw new Error("Explicit Node is required for the Bun transport proof.");
}
assert.ok("bun" in process.versions, "this fixture must execute under Bun");
assert.equal(requireAdmittedNodeExecutable({ AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: explicitNode }, process.execPath), explicitNode);
const explicitNodePath: string = explicitNode;
const admittedEnvironment: NodeJS.ProcessEnv = Object.freeze({
  ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  [NODE_EXECUTABLE_ENVIRONMENT_VARIABLE]: explicitNode
});
const runtimeContext = Object.freeze({ nodeExecutable: explicitNode, launcherEnvironment: admittedEnvironment });
const fixtureParent = join(process.cwd(), ".cache", ".worker-tmp", "process-runtime-delegation-under-bun");
mkdirSync(fixtureParent, { recursive: true });
const fixtureRoot = mkdtempSync(join(fixtureParent, "owned-descendants-"));
let fallbackCleanupUsed = false;
const managedLifetimeMs = 3_000;
const markerReadinessMs = 500;
const cleanupSettlementMs = 1_000;

type Identity = { parent: number; descendant: number };
type Observation = { pid: number; processState: string; signalProbe: "alive" | "missing" | "denied"; terminal: boolean };
type Outcome =
  | { kind: "normal"; exitCode: number; signal: string | null }
  | { kind: "cancelled"; className: string; reason: string };
type Evidence = {
  identity: Identity;
  before: Observation[];
  after: Observation[];
  groupBefore: boolean;
  groupAfter: boolean;
  outcome: Outcome;
};
type FailedReadinessEvidence = {
  identity: Identity;
  before: Observation[];
  atMarkerFailure: Observation[];
  after: Observation[];
  groupBefore: boolean;
  groupAfter: boolean;
  markerFailure: string;
  outcome: { kind: "timeout"; className: string; timeoutMs: number };
  managedCleanupQualified: boolean;
  qualifiesTransportSuccess: false;
};

type Settlement = { settled: true; value?: ManagedProcessResult; error?: unknown } | { settled: false };

function managedRequest(source: string, signal?: AbortSignal) {
  return {
    command: explicitNodePath,
    args: ["-e", source],
    cwd: fixtureRoot,
    environment: admittedEnvironment,
    timeoutMs: managedLifetimeMs,
    ...(signal === undefined ? {} : { signal })
  };
}

async function settleWithin(fixtureProcess: Promise<ManagedProcessResult>, timeoutMs: number): Promise<Settlement> {
  const settled = fixtureProcess.then(
    (value): Settlement => ({ settled: true, value }),
    (error: unknown): Settlement => ({ settled: true, error })
  );
  const expired: Settlement = { settled: false };
  return Promise.race([settled, delay(timeoutMs, expired)]);
}

async function waitForFixtureMarker(marker: string, fixtureProcess: Promise<ManagedProcessResult>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const earlySettlement = fixtureProcess.then(
    result => new Error(`Fixture settled before ${marker}: exitCode=${String(result.exitCode)} signal=${String(result.signal)} stderr=${JSON.stringify(result.stderr)}`),
    (error: unknown) => error
  );
  const readiness = (async () => {
    let failure: unknown = new Error("Fixture marker readiness failed before its first observation.");
    while (Date.now() < deadline) {
      try {
        await readFile(marker, "utf8");
        return;
      } catch (error) {
        failure = error;
      }
      await delay(2);
    }
    return new Error(`Fixture marker readiness timed out: ${marker}`, { cause: failure });
  })();
  const failure = await Promise.race([readiness, earlySettlement]);
  if (failure !== undefined) {
    throw failure;
  }
}

async function observeOwnedPid(pid: number): Promise<Observation> {
  let processState = "gone";
  try {
    const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
    const closingName = stat.lastIndexOf(")");
    processState = closingName < 0 ? "unknown" : stat.slice(closingName + 2, closingName + 3);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  let signalProbe: Observation["signalProbe"];
  try {
    process.kill(pid, 0);
    signalProbe = "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    signalProbe = code === "ESRCH" ? "missing" : code === "EPERM" ? "denied" : (() => { throw error; })();
  }
  return {
    pid,
    processState,
    signalProbe,
    terminal: processState === "gone" || ["Z", "X", "x"].includes(processState) || signalProbe === "missing"
  };
}

async function readOwnedIdentity(marker: string): Promise<Identity> {
  const parsed: unknown = JSON.parse(await readFile(marker, "utf8"));
  if (
    typeof parsed !== "object" || parsed === null ||
    !Number.isSafeInteger((parsed as Partial<Identity>).parent) ||
    !Number.isSafeInteger((parsed as Partial<Identity>).descendant)
  ) {
    throw new Error(`Invalid owned identity marker: ${marker}`);
  }
  const identity = parsed as Identity;
  if (identity.parent <= 0 || identity.descendant <= 0 || identity.parent === identity.descendant) {
    throw new Error(`Unsafe owned identity marker: ${marker}`);
  }
  return identity;
}

function probeOwnedGroup(parentPid: number): boolean {
  try {
    process.kill(-parentPid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      return true;
    }
    return false;
  }
}

async function cleanupOwnedGroup(parentPid: number | undefined): Promise<void> {
  if (parentPid === undefined || !probeOwnedGroup(parentPid)) {
    return;
  }
  fallbackCleanupUsed = true;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-parentPid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      throw error;
    }
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && probeOwnedGroup(parentPid)) {
      await delay(25);
    }
    if (!probeOwnedGroup(parentPid)) {
      return;
    }
  }
}

function retainedFixtureSource(identityMarker: string, childReadyMarker: string, readyMarker?: string, releaseMarker?: string): string {
  const descendant = [
    `const fs=require("node:fs");`,
    `process.on("SIGTERM",()=>{});`,
    `fs.writeFileSync(${JSON.stringify(childReadyMarker)},"ready");`,
    `setInterval(()=>{},1000)`
  ].join("");
  return [
    `const fs=require("node:fs");`,
    `const cp=require("node:child_process");`,
    `const child=cp.spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:"ignore"});`,
    `child.once("error",error=>{process.stderr.write(String(error));process.exitCode=91;});`,
    `fs.writeFileSync(${JSON.stringify(identityMarker)},JSON.stringify({parent:process.pid,descendant:child.pid}));`,
    `const deadline=Date.now()+5000;`,
    `const waitFor=async path=>{while(!fs.existsSync(path)){if(Date.now()>=deadline)throw new Error("marker readiness expired");await new Promise(resolve=>setTimeout(resolve,2));}};`,
    `(async()=>{await waitFor(${JSON.stringify(childReadyMarker)});`,
    readyMarker === undefined ? `` : `fs.writeFileSync(${JSON.stringify(readyMarker)},"ready");`,
    releaseMarker === undefined ? `setInterval(()=>{},1000);` : `await waitFor(${JSON.stringify(releaseMarker)});process.exit(0);`,
    `})().catch(error=>{process.stderr.write(String(error));process.exitCode=93;});`
  ].join("");
}

async function proveDescendantCleanup(mode: "normal" | "cancel"): Promise<Evidence> {
  const markers = {
    identity: join(fixtureRoot, `${mode}-identity.json`),
    ready: join(fixtureRoot, `${mode}-ready`),
    release: join(fixtureRoot, `${mode}-release`)
  };
  const controller = new AbortController();
  const run = executeManagedProcess(
    managedRequest(retainedFixtureSource(markers.identity, markers.ready, undefined, mode === "normal" ? markers.release : undefined), mode === "cancel" ? controller.signal : undefined),
    runtimeContext
  );
  void run.catch(() => {
    return;
  });
  let identity: Identity | undefined;
  let outcome: Outcome | undefined;
  try {
    await Promise.all([
      waitForFixtureMarker(markers.identity, run),
      waitForFixtureMarker(markers.ready, run)
    ]);
    identity = await readOwnedIdentity(markers.identity);
    const before = await Promise.all([observeOwnedPid(identity.parent), observeOwnedPid(identity.descendant)]);
    const groupBefore = probeOwnedGroup(identity.parent);
    assert.equal(before[0]?.terminal, false, "managed parent must be live at custody proof");
    assert.equal(before[1]?.terminal, false, "retained descendant must be live at custody proof");
    assert.equal(groupBefore, true, "the exact retained process group must exist at custody proof");
    if (mode === "normal") {
      await writeFile(markers.release, "release");
      const result = await run;
      assert.equal(result.exitCode, 0);
      assert.equal(result.signal, null);
      assert.deepEqual({ ...readProcessFailureFacts(result) }, { reason: "exit", exitCode: 0 });
      outcome = { kind: "normal", exitCode: result.exitCode, signal: result.signal };
    } else {
      controller.abort(new Error("cancel-while-retained-descendant-is-live"));
      await assert.rejects(run, (error: unknown) => {
        if (!(error instanceof ProcessCancellationError)) {
          return false;
        }
        assert.deepEqual({ ...readProcessFailureFacts(error) }, { reason: "cancelled" });
        outcome = { kind: "cancelled", className: error.name, reason: "cancelled" };
        return true;
      });
    }
    const after = await Promise.all([observeOwnedPid(identity.parent), observeOwnedPid(identity.descendant)]);
    assert.equal(after[0]?.terminal, true, "managed parent must be terminal after owned cleanup");
    assert.equal(after[1]?.terminal, true, "retained descendant must be terminal after owned cleanup");
    const groupAfter = probeOwnedGroup(identity.parent);
    assert.equal(groupAfter, false, "owned cleanup must retire the exact process group");
    assert.ok(outcome);
    return { identity, before, after, groupBefore, groupAfter, outcome };
  } finally {
    if (mode === "normal") {
      await writeFile(markers.release, "release").catch(() => {
        return;
      });
    } else if (!controller.signal.aborted) {
      controller.abort(new Error("cancel-during-fixture-cleanup"));
    }
    const settlement = await settleWithin(run, cleanupSettlementMs);
    if (identity === undefined) {
      identity = await readOwnedIdentity(markers.identity).catch((): Identity | undefined => {
        return;
      });
    }
    if (identity !== undefined && (!settlement.settled || probeOwnedGroup(identity.parent))) {
      await cleanupOwnedGroup(identity.parent).catch(() => {
        return;
      });
    }
    await Promise.all(Object.values(markers).map(marker => rm(marker, { force: true })));
  }
}

async function proveFailedReadinessCleanup(): Promise<FailedReadinessEvidence> {
  const markers = {
    identity: join(fixtureRoot, "failed-readiness-identity.json"),
    childReady: join(fixtureRoot, "failed-readiness-child-ready"),
    ready: join(fixtureRoot, "failed-readiness-ready"),
    release: join(fixtureRoot, "failed-readiness-release")
  };
  const controller = new AbortController();
  const run = executeManagedProcess(
    managedRequest(retainedFixtureSource(markers.identity, markers.childReady), controller.signal),
    runtimeContext
  );
  void run.catch(() => {
    return;
  });
  let identity: Identity | undefined;
  let markerFailure = "";
  let outcome: FailedReadinessEvidence["outcome"] | undefined;
  try {
    await waitForFixtureMarker(markers.identity, run);
    await waitForFixtureMarker(markers.childReady, run);
    identity = await readOwnedIdentity(markers.identity);
    const before = await Promise.all([observeOwnedPid(identity.parent), observeOwnedPid(identity.descendant)]);
    const groupBefore = probeOwnedGroup(identity.parent);
    assert.equal(before[0]?.terminal, false, "managed parent must be live before failed readiness");
    assert.equal(before[1]?.terminal, false, "retained descendant must be live before failed readiness");
    assert.equal(groupBefore, true, "the exact retained process group must exist before failed readiness");
    await assert.rejects(waitForFixtureMarker(markers.ready, run, markerReadinessMs), (error: unknown) => {
      assert.ok(error instanceof Error);
      markerFailure = error.message;
      return true;
    });
    const atMarkerFailure = await Promise.all([observeOwnedPid(identity.parent), observeOwnedPid(identity.descendant)]);
    assert.equal(atMarkerFailure[0]?.terminal, false, "failed readiness must preserve the live managed parent");
    assert.equal(atMarkerFailure[1]?.terminal, false, "failed readiness must preserve the live retained descendant");
    await assert.rejects(run, (error: unknown) => {
      if (!(error instanceof ProcessTimeoutError)) {
        return false;
      }
      assert.deepEqual({ ...readProcessFailureFacts(error) }, { reason: "timeout", timeoutMs: managedLifetimeMs });
      outcome = { kind: "timeout", className: error.name, timeoutMs: error.timeoutMs };
      return true;
    });
    const after = await Promise.all([observeOwnedPid(identity.parent), observeOwnedPid(identity.descendant)]);
    const groupAfter = probeOwnedGroup(identity.parent);
    assert.equal(after[0]?.terminal, true, "managed parent must be terminal after failed-readiness cleanup");
    assert.equal(after[1]?.terminal, true, "retained descendant must be terminal after failed-readiness cleanup");
    assert.equal(groupAfter, false, "managed cleanup must retire the exact group after failed readiness");
    assert.ok(outcome);
    return {
      identity,
      before,
      atMarkerFailure,
      after,
      groupBefore,
      groupAfter,
      markerFailure,
      outcome,
      managedCleanupQualified: true,
      qualifiesTransportSuccess: false
    };
  } finally {
    if (!controller.signal.aborted) {
      controller.abort(new Error("cancel-during-failed-readiness-cleanup"));
    }
    const settlement = await settleWithin(run, cleanupSettlementMs);
    if (identity === undefined) {
      identity = await readOwnedIdentity(markers.identity).catch((): Identity | undefined => {
        return;
      });
    }
    if (identity !== undefined && (!settlement.settled || probeOwnedGroup(identity.parent))) {
      await cleanupOwnedGroup(identity.parent).catch(() => {
        return;
      });
    }
    await Promise.all(Object.values(markers).map(marker => rm(marker, { force: true })));
  }
}

try {
  const result = await executeManagedProcess({
    command: explicitNode,
    args: ["-e", "process.stdout.write(JSON.stringify({execPath:process.execPath,versions:process.versions}))"],
    cwd: fixtureRoot,
    environment: admittedEnvironment,
    timeoutMs: 5_000
  }, runtimeContext);
  const child = JSON.parse(result.stdout) as { execPath: string; versions: Record<string, string> };
  assert.equal(child.versions["node"], "26.11.1");
  assert.equal("bun" in child.versions, false);

  const nonzero = await executeManagedProcess({
    command: explicitNode,
    args: ["-e", "process.exitCode=17"],
    cwd: fixtureRoot,
    environment: admittedEnvironment,
    timeoutMs: 5_000
  }, runtimeContext);
  assert.equal(nonzero.exitCode, 17);
  assert.deepEqual({ ...readProcessFailureFacts(nonzero) }, { reason: "exit", exitCode: 17 });
  await assert.rejects(new NodeProcessRunner().run({
    command: explicitNode,
    args: ["-e", "process.exitCode=17"],
    cwd: fixtureRoot,
    timeoutMs: 5_000
  }), (error: unknown) => {
    assert.equal(readProcessFailureFacts(error)?.reason, "exit");
    return true;
  });

  const descendantProofSupported = process.platform === "linux";
  const normalParentExit = descendantProofSupported ? await proveDescendantCleanup("normal") : undefined;
  const cancellation = descendantProofSupported ? await proveDescendantCleanup("cancel") : undefined;
  const failedReadiness = descendantProofSupported ? await proveFailedReadinessCleanup() : undefined;
  assert.equal(fallbackCleanupUsed, false, "fallback cleanup cannot qualify transport custody");
  process.stdout.write(JSON.stringify({
    transport: "node-child-process-adapter-inside-bun",
    hostRuntime: process.versions["bun"],
    hostExecutable: process.execPath,
    childExecutable: child.execPath,
    childNode: child.versions["node"],
    hostPair: "accepted Node transport with Foundation acquire/cleanup hooks",
    descendantProof: descendantProofSupported ? "linux-posix" : "not-run",
    normalParentExit,
    cancellation,
    failedReadiness,
    fallbackCleanupUsed
  }));
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
