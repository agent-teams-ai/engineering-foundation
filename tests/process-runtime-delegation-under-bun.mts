import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  ProcessCancellationError,
  ProcessTimeoutError,
  type ManagedProcessResult,
} from "../packages/engineering-foundation/dist/process-execution/api.js";
import {
  NodeProcessRunner,
  executeManagedProcess,
} from "../packages/engineering-foundation/dist/process-execution/node-process-runner.js";
import { readProcessFailureFacts } from "../packages/engineering-foundation/dist/features/validation-reporting/process-failure-facts.js";
import {
  observeOwnedPid,
  proveDarwinRetainedGroup,
  waitForFixtureMarker,
  type Observation,
} from "./support/process-runtime-custody.mts";
import {
  NODE_EXECUTABLE_ENVIRONMENT_VARIABLE,
  requireAdmittedNodeExecutable,
} from "../packages/engineering-foundation/dist/process-execution/node-runtime-verifier.js";

const explicitNode = process.env["PROCESS_RUNTIME_DELEGATION_NODE"];
if (typeof explicitNode !== "string") {
  throw new Error("Explicit Node is required for the Bun transport proof.");
}
assert.ok("bun" in process.versions, "this fixture must execute under Bun");
assert.equal(process.versions["bun"], "1.4.3", "custody proof requires the pinned Bun profile");
assert.equal(
  requireAdmittedNodeExecutable(
    { AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: explicitNode },
    process.execPath,
  ),
  explicitNode,
);
if (process.platform === "win32") {
  assert.equal(
    process.env[NODE_EXECUTABLE_ENVIRONMENT_VARIABLE],
    explicitNode,
    "the runner also requires explicit ambient Node admission",
  );
}
const explicitNodePath: string = explicitNode;
const admittedEnvironment: NodeJS.ProcessEnv = Object.freeze({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  [NODE_EXECUTABLE_ENVIRONMENT_VARIABLE]: explicitNode,
});
const runtimeContext = Object.freeze({
  nodeExecutable: explicitNode,
  launcherEnvironment: admittedEnvironment,
});
const fixtureParent = join(
  process.cwd(),
  ".cache",
  ".worker-tmp",
  "process-runtime-delegation-under-bun",
);
mkdirSync(fixtureParent, { recursive: true });
const fixtureRoot = mkdtempSync(join(fixtureParent, "owned-descendants-"));
let qualified = false;
const managedLifetimeMs = process.platform === "win32" ? 60_000 : 3_000;
const readinessMs = process.platform === "win32" ? 30_000 : 5_000;
const markerReadinessMs = 500;
const cleanupSettlementMs = 1_000;

type Identity = { parent: number; descendant: number; host?: number };
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

type Settlement =
  | { settled: true; value?: ManagedProcessResult; error?: unknown }
  | { settled: false };

function managedRequest(source: string, signal?: AbortSignal) {
  return {
    command: explicitNodePath,
    args: ["-e", source],
    cwd: fixtureRoot,
    environment: admittedEnvironment,
    timeoutMs: managedLifetimeMs,
    ...(signal === undefined ? {} : { signal }),
  };
}

async function settleWithin(
  fixtureProcess: Promise<ManagedProcessResult>,
  timeoutMs: number,
): Promise<Settlement> {
  const settled = fixtureProcess.then(
    (value): Settlement => ({ settled: true, value }),
    (error: unknown): Settlement => ({ settled: true, error }),
  );
  const expired: Settlement = { settled: false };
  const timer = new AbortController();
  try {
    return await Promise.race([settled, delay(timeoutMs, expired, { signal: timer.signal })]);
  } finally {
    timer.abort();
  }
}

async function readOwnedIdentity(marker: string): Promise<Identity> {
  const parsed: unknown = JSON.parse(await readFile(marker, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
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

function retainedFixtureSource(
  identityMarker: string,
  childReadyMarker: string,
  readyMarker?: string,
  releaseMarker?: string,
): string {
  const descendant = [
    `const fs=require("node:fs");`,
    `process.on("SIGTERM",()=>{});`,
    `fs.writeFileSync(${JSON.stringify(childReadyMarker)},"ready");`,
    `setInterval(()=>{},1000)`,
  ].join("");
  return [
    `const fs=require("node:fs");`,
    `const cp=require("node:child_process");`,
    `const child=cp.spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:"ignore"});`,
    `child.once("error",error=>{process.stderr.write(String(error));process.exitCode=91;});`,
    `fs.writeFileSync(${JSON.stringify(identityMarker)},JSON.stringify({parent:process.pid,descendant:child.pid,host:process.ppid}));`,
    `const deadline=Date.now()+${String(managedLifetimeMs)};`,
    `const waitFor=async path=>{while(!fs.existsSync(path)){if(Date.now()>=deadline)throw new Error("marker readiness expired");await new Promise(resolve=>setTimeout(resolve,2));}};`,
    `(async()=>{await waitFor(${JSON.stringify(childReadyMarker)});`,
    readyMarker === undefined ? `` : `fs.writeFileSync(${JSON.stringify(readyMarker)},"ready");`,
    releaseMarker === undefined
      ? `setInterval(()=>{},1000);`
      : `await waitFor(${JSON.stringify(releaseMarker)});process.exit(0);`,
    `})().catch(error=>{process.stderr.write(String(error));process.exitCode=93;});`,
  ].join("");
}

async function proveDescendantCleanup(mode: "normal" | "cancel"): Promise<Evidence> {
  const markers = {
    identity: join(fixtureRoot, `${mode}-identity.json`),
    ready: join(fixtureRoot, `${mode}-ready`),
    release: join(fixtureRoot, `${mode}-release`),
  };
  const controller = new AbortController();
  const run = executeManagedProcess(
    managedRequest(
      retainedFixtureSource(
        markers.identity,
        markers.ready,
        undefined,
        mode === "normal" ? markers.release : undefined,
      ),
      mode === "cancel" ? controller.signal : undefined,
    ),
    runtimeContext,
  );
  void run.catch(() => {
    return;
  });
  let identity: Identity | undefined;
  let outcome: Outcome | undefined;
  try {
    await Promise.all([
      waitForFixtureMarker(markers.identity, run, readinessMs),
      waitForFixtureMarker(markers.ready, run, readinessMs),
    ]);
    identity = await readOwnedIdentity(markers.identity);
    const before = await Promise.all([
      observeOwnedPid(identity.parent),
      observeOwnedPid(identity.descendant),
    ]);
    const groupBefore = probeOwnedGroup(identity.parent);
    assert.equal(before[0].terminal, false, "managed parent must be live at custody proof");
    assert.equal(before[1].terminal, false, "retained descendant must be live at custody proof");
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
    const after = await Promise.all([
      observeOwnedPid(identity.parent),
      observeOwnedPid(identity.descendant),
    ]);
    assert.equal(after[0].terminal, true, "managed parent must be terminal after owned cleanup");
    assert.equal(
      after[1].terminal,
      true,
      "retained descendant must be terminal after owned cleanup",
    );
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
    const groupRemains = identity !== undefined && probeOwnedGroup(identity.parent);
    assert.ok(
      settlement.settled && !groupRemains,
      JSON.stringify({
        phase: "POSIX-fixture-retirement",
        settled: settlement.settled,
        identity,
        groupRemains,
      }),
    );
  }
}

async function proveFailedReadinessCleanup(): Promise<FailedReadinessEvidence> {
  const markers = {
    identity: join(fixtureRoot, "failed-readiness-identity.json"),
    childReady: join(fixtureRoot, "failed-readiness-child-ready"),
    ready: join(fixtureRoot, "failed-readiness-ready"),
    release: join(fixtureRoot, "failed-readiness-release"),
  };
  const controller = new AbortController();
  const run = executeManagedProcess(
    managedRequest(retainedFixtureSource(markers.identity, markers.childReady), controller.signal),
    runtimeContext,
  );
  void run.catch(() => {
    return;
  });
  let identity: Identity | undefined;
  let markerFailure = "";
  let outcome: FailedReadinessEvidence["outcome"] | undefined;
  try {
    await waitForFixtureMarker(markers.identity, run, readinessMs);
    await waitForFixtureMarker(markers.childReady, run, readinessMs);
    identity = await readOwnedIdentity(markers.identity);
    const before = await Promise.all([
      observeOwnedPid(identity.parent),
      observeOwnedPid(identity.descendant),
    ]);
    const groupBefore = probeOwnedGroup(identity.parent);
    assert.equal(before[0].terminal, false, "managed parent must be live before failed readiness");
    assert.equal(
      before[1].terminal,
      false,
      "retained descendant must be live before failed readiness",
    );
    assert.equal(
      groupBefore,
      true,
      "the exact retained process group must exist before failed readiness",
    );
    await assert.rejects(
      waitForFixtureMarker(markers.ready, run, markerReadinessMs),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        markerFailure = error.message;
        return true;
      },
    );
    const atMarkerFailure = await Promise.all([
      observeOwnedPid(identity.parent),
      observeOwnedPid(identity.descendant),
    ]);
    assert.equal(
      atMarkerFailure[0].terminal,
      false,
      "failed readiness must preserve the live managed parent",
    );
    assert.equal(
      atMarkerFailure[1].terminal,
      false,
      "failed readiness must preserve the live retained descendant",
    );
    await assert.rejects(run, (error: unknown) => {
      if (!(error instanceof ProcessTimeoutError)) {
        return false;
      }
      assert.deepEqual(
        { ...readProcessFailureFacts(error) },
        { reason: "timeout", timeoutMs: managedLifetimeMs },
      );
      outcome = { kind: "timeout", className: error.name, timeoutMs: error.timeoutMs };
      return true;
    });
    const after = await Promise.all([
      observeOwnedPid(identity.parent),
      observeOwnedPid(identity.descendant),
    ]);
    const groupAfter = probeOwnedGroup(identity.parent);
    assert.equal(
      after[0].terminal,
      true,
      "managed parent must be terminal after failed-readiness cleanup",
    );
    assert.equal(
      after[1].terminal,
      true,
      "retained descendant must be terminal after failed-readiness cleanup",
    );
    assert.equal(
      groupAfter,
      false,
      "managed cleanup must retire the exact group after failed readiness",
    );
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
      qualifiesTransportSuccess: false,
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
    const groupRemains = identity !== undefined && probeOwnedGroup(identity.parent);
    assert.ok(
      settlement.settled && !groupRemains,
      JSON.stringify({
        phase: "POSIX-fixture-retirement",
        settled: settlement.settled,
        identity,
        groupRemains,
      }),
    );
  }
}

async function readOwnedWindowsWrapper(
  identity: Identity,
): Promise<{ wrapper: number; control: string }> {
  assert.ok(
    typeof identity.host === "number" && Number.isSafeInteger(identity.host) && identity.host > 0,
  );
  const systemRoot = Object.entries(admittedEnvironment).find(
    ([name]) => name.toLowerCase() === "systemroot",
  )?.[1];
  assert.ok(systemRoot !== undefined && systemRoot !== "" && isAbsolute(systemRoot));
  // Query only our recorded host. CommandLine is used solely to recover its
  // private request path; neither it nor the requested command is logged.
  const query = spawnSync(
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);` +
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${String(identity.host)}';` +
        `$m=[regex]::Match($p.CommandLine,'(?:"([^"\\r\\n]+\\\\request\\.json)"|(\\S+\\\\request\\.json))$');` +
        `if(!$m.Success){throw 'Owned request path unavailable'};` +
        `$r=if($m.Groups[1].Success){$m.Groups[1].Value}else{$m.Groups[2].Value};` +
        `[Console]::Write((@{wrapper=[int]$p.ParentProcessId;request=$r}|ConvertTo-Json -Compress))`,
    ],
    {
      encoding: "utf8",
      env: admittedEnvironment,
      timeout: 10_000,
      maxBuffer: 4_096,
      windowsHide: true,
    },
  );
  assert.equal(
    query.status,
    0,
    JSON.stringify({
      phase: "owned-Windows-host-query",
      pid: identity.host,
      status: query.status,
      signal: query.signal,
    }),
  );
  const parsed = JSON.parse(query.stdout) as { wrapper: number; request: string };
  assert.ok(
    Number.isSafeInteger(parsed.wrapper) && parsed.wrapper > 0 && parsed.wrapper !== identity.host,
  );
  assert.ok(typeof parsed.request === "string" && isAbsolute(parsed.request));
  const control = dirname(parsed.request);
  assert.equal(resolve(dirname(control)).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(basename(control).startsWith("agent-teams-foundation-process-"));
  assert.equal(basename(parsed.request), "request.json");
  const request = JSON.parse(await readFile(parsed.request, "utf8")) as {
    command: string;
    cwd: string;
    launchPath: string;
  };
  assert.equal(request.command, explicitNodePath);
  assert.equal(request.cwd, fixtureRoot);
  assert.equal(request.launchPath, join(control, "launched"));
  assert.equal(await readFile(request.launchPath, "utf8"), "STARTED");
  return { wrapper: parsed.wrapper, control };
}

async function proveWindowsCleanup(mode: "normal" | "cancel" | "failure") {
  const markers = {
    identity: join(fixtureRoot, `${mode}-identity.json`),
    ready: join(fixtureRoot, `${mode}-ready`),
    release: join(fixtureRoot, `${mode}-release`),
  };
  const controller = new AbortController();
  const run = executeManagedProcess(
    managedRequest(
      retainedFixtureSource(
        markers.identity,
        markers.ready,
        undefined,
        mode === "normal" ? markers.release : undefined,
      ),
      controller.signal,
    ),
    runtimeContext,
  );
  void run.catch(() => {
    return;
  });
  let identity: Identity | undefined;
  let custody: Awaited<ReturnType<typeof readOwnedWindowsWrapper>> | undefined;
  try {
    await Promise.all([
      waitForFixtureMarker(markers.identity, run, readinessMs),
      waitForFixtureMarker(markers.ready, run, readinessMs),
    ]);
    identity = await readOwnedIdentity(markers.identity);
    custody = await readOwnedWindowsWrapper(identity);
    const pids = [identity.parent, identity.descendant, identity.host!, custody.wrapper];
    assert.equal(new Set(pids).size, 4, "Windows custody identities must be distinct");
    const before = await Promise.all(pids.map(observeOwnedPid));
    assert.ok(
      before.every((value) => value.signalProbe === "alive"),
      JSON.stringify({ phase: "Windows-before", observations: before }),
    );
    let readinessFailed = false;
    let atMarkerFailure: Observation[] | undefined;
    let outcome: ReturnType<typeof readProcessFailureFacts>;
    if (mode === "normal") {
      await writeFile(markers.release, "release");
      const result = await run;
      outcome = readProcessFailureFacts(result);
      assert.equal(result.signal, null);
      assert.deepEqual({ ...outcome }, { reason: "exit", exitCode: 0 });
    } else if (mode === "cancel") {
      controller.abort(new Error("cancel-owned-Windows-job"));
      await assert.rejects(run, (error: unknown) => {
        outcome = readProcessFailureFacts(error);
        return error instanceof ProcessCancellationError && outcome?.reason === "cancelled";
      });
    } else {
      await assert.rejects(
        waitForFixtureMarker(
          join(fixtureRoot, "intentionally-missing-ready"),
          run,
          markerReadinessMs,
        ),
        /marker readiness timed out/u,
      );
      atMarkerFailure = await Promise.all(pids.map(observeOwnedPid));
      assert.ok(
        atMarkerFailure.every((value) => value.signalProbe === "alive"),
        JSON.stringify({ phase: "Windows-marker-failure", observations: atMarkerFailure }),
      );
      readinessFailed = true;
      await assert.rejects(run, (error: unknown) => {
        outcome = readProcessFailureFacts(error);
        if (!(error instanceof ProcessTimeoutError)) {
          return false;
        }
        assert.deepEqual({ ...outcome }, { reason: "timeout", timeoutMs: managedLifetimeMs });
        return true;
      });
    }
    const after = await Promise.all(pids.map(observeOwnedPid));
    assert.ok(
      after.every((value) => value.signalProbe === "missing"),
      JSON.stringify({
        phase: "Windows-after",
        observations: after,
        requirement: "ESRCH; EPERM is unproven",
      }),
    );
    await assert.rejects(readFile(join(custody.control, "request.json")), { code: "ENOENT" });
    await assert.rejects(lstat(custody.control), { code: "ENOENT" });
    assert.ok(outcome);
    return {
      mode,
      identity,
      wrapper: custody.wrapper,
      before,
      atMarkerFailure,
      after,
      outcome,
      controlRetired: true,
      readinessFailed,
      qualifiesTransportSuccess: mode !== "failure",
    };
  } finally {
    if (!controller.signal.aborted) {
      controller.abort(new Error("finish-owned-Windows-fixture"));
    }
    const settlement = await settleWithin(run, 35_000);
    const owned = [custody?.wrapper, identity?.host, identity?.parent, identity?.descendant].filter(
      (pid): pid is number => pid !== undefined,
    );
    const remaining = await Promise.all(owned.map(observeOwnedPid));
    assert.ok(
      settlement.settled && remaining.every((value) => value.signalProbe === "missing"),
      JSON.stringify({
        phase: "Windows-fixture-retirement",
        settled: settlement.settled,
        observations: remaining,
        requirement: "ESRCH; EPERM is unproven",
      }),
    );
    if (custody !== undefined) {
      await assert.rejects(
        lstat(custody.control),
        { code: "ENOENT" },
        "Host must retire its native control directory",
      );
    }
  }
}

try {
  const result = await executeManagedProcess(
    {
      command: explicitNode,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({execPath:process.execPath,versions:process.versions}))",
      ],
      cwd: fixtureRoot,
      environment: admittedEnvironment,
      timeoutMs: Math.max(5_000, managedLifetimeMs),
    },
    runtimeContext,
  );
  const child = JSON.parse(result.stdout) as { execPath: string; versions: Record<string, string> };
  assert.equal(child.versions["node"], "26.11.1");
  assert.equal("bun" in child.versions, false);

  const nonzero = await executeManagedProcess(
    {
      command: explicitNode,
      args: ["-e", "process.exitCode=17"],
      cwd: fixtureRoot,
      environment: admittedEnvironment,
      timeoutMs: Math.max(5_000, managedLifetimeMs),
    },
    runtimeContext,
  );
  assert.equal(nonzero.exitCode, 17);
  assert.deepEqual({ ...readProcessFailureFacts(nonzero) }, { reason: "exit", exitCode: 17 });
  await assert.rejects(
    new NodeProcessRunner().run({
      command: explicitNode,
      args: ["-e", "process.exitCode=17"],
      cwd: fixtureRoot,
      timeoutMs: Math.max(5_000, managedLifetimeMs),
    }),
    (error: unknown) => {
      assert.equal(readProcessFailureFacts(error)?.reason, "exit");
      return true;
    },
  );

  const descendantProofSupported = process.platform === "linux" || process.platform === "darwin";
  const normalParentExit = descendantProofSupported
    ? await proveDescendantCleanup("normal")
    : undefined;
  const cancellation = descendantProofSupported
    ? await proveDescendantCleanup("cancel")
    : undefined;
  const failedReadiness = descendantProofSupported
    ? await proveFailedReadinessCleanup()
    : undefined;
  const windows =
    process.platform === "win32"
      ? {
          normal: await proveWindowsCleanup("normal"),
          cancelled: await proveWindowsCleanup("cancel"),
          failedReadiness: await proveWindowsCleanup("failure"),
        }
      : undefined;
  const darwin =
    process.platform === "darwin"
      ? {
          transient: await proveDarwinRetainedGroup(
            false,
            fixtureRoot,
            admittedEnvironment,
            runtimeContext,
          ),
          persistent: await proveDarwinRetainedGroup(
            true,
            fixtureRoot,
            admittedEnvironment,
            runtimeContext,
          ),
        }
      : undefined;
  process.stdout.write(
    JSON.stringify({
      transport: "node-child-process-adapter-inside-bun",
      hostRuntime: process.versions["bun"],
      hostExecutable: process.execPath,
      childExecutable: child.execPath,
      childNode: child.versions["node"],
      hostPair: "accepted Node transport with Foundation acquire/cleanup hooks",
      descendantProof:
        process.platform === "linux"
          ? "linux-posix"
          : process.platform === "win32"
            ? "windows-job"
            : process.platform === "darwin"
              ? "darwin-posix-and-retained-group"
              : "not-run",
      normalParentExit,
      cancellation,
      failedReadiness,
      windows,
      darwin,
      fallbackCleanupUsed: false,
    }),
  );
  qualified = true;
} finally {
  if (qualified) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(
      `Custody qualification failed; owned fixture evidence retained at ${fixtureRoot}\n`,
    );
  }
}
