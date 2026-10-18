import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isProcessRuntimeError } from "node-or-bun";
import type { ManagedProcessResult } from "../../packages/engineering-foundation/dist/process-execution/api.js";
import { executeManagedProcess, type NodeManagedProcessRuntimeContext } from "../../packages/engineering-foundation/dist/process-execution/node-process-runner.js";
import { readProcessFailureFacts } from "../../packages/engineering-foundation/dist/features/validation-reporting/process-failure-facts.js";

export type Observation = Readonly<{ pid: number; processState: string; signalProbe: "alive" | "missing" | "denied"; terminal: boolean }>;
type DarwinIdentity = Readonly<{ parent: number; child: number; custodian: number; custodianPgid: number; childPgid: number; childSid: number; sid: number; zombieState: string }>;

export async function waitForFixtureMarker(marker: string, fixtureProcess: Promise<ManagedProcessResult>, timeoutMs: number): Promise<void> {
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
    throw failure instanceof Error ? failure : new Error("Fixture process failed before marker readiness", { cause: failure });
  }
}

export async function observeOwnedPid(pid: number): Promise<Observation> {
  let processState = "unobserved";
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
      const closingName = stat.lastIndexOf(")");
      processState = closingName < 0 ? "unknown" : stat.slice(closingName + 2, closingName + 3);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      processState = "gone";
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
  return Object.freeze({
    pid,
    processState,
    signalProbe,
    terminal: processState === "gone" || ["Z", "X", "x"].includes(processState) || signalProbe === "missing"
  });
}

function describeDarwinFailure(failure: unknown) {
  const runtimeError = failure instanceof Error && isProcessRuntimeError(failure.cause) ? failure.cause : undefined;
  const nativeCause = runtimeError?.cause;
  const nativeCode = nativeCause instanceof Error && "code" in nativeCause ? nativeCause.code : undefined;
  return {
    phase: "Darwin-transient-retained-custody", failure: readProcessFailureFacts(failure),
    runtimeCode: runtimeError?.code, runtimeMessage: runtimeError?.message, facts: runtimeError?.facts,
    nativeCode: nativeCode === "EPERM" || nativeCode === "ESRCH" ? nativeCode : undefined
  };
}

export async function proveDarwinRetainedGroup(
  persistent: boolean, fixtureRoot: string, admittedEnvironment: Readonly<NodeJS.ProcessEnv>, runtimeContext: NodeManagedProcessRuntimeContext
) {
  const root = mkdtempSync(join(fixtureRoot, persistent ? "persistent-zombie-" : "transient-zombie-"));
  const python = spawnSync("python3", ["--version"], { encoding: "utf8", timeout: 5_000 });
  assert.equal(python.status, 0, "Darwin custody requires Python3");
  const run = executeManagedProcess({ command: "python3", args: [fileURLToPath(new URL("../fixtures/darwin-retained-group.py", import.meta.url)), root], cwd: fixtureRoot, environment: admittedEnvironment, timeoutMs: 5_000 }, runtimeContext);
  const settlement = { settled: false };
  const command = run.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
  void command.then(() => {
    settlement.settled = true;
    return;
  });
  let record: DarwinIdentity | undefined;
  let reaped: { waited: number; status: number; groupProbe: string } | undefined;
  try {
    await waitForFixtureMarker(join(root, "ready.json"), run, 5_000);
    record = JSON.parse(await readFile(join(root, "ready.json"), "utf8")) as DarwinIdentity;
    for (const pid of [record.parent, record.child, record.custodian]) {
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
    }
    assert.equal(record.sid, record.parent);
    assert.equal(record.childPgid, record.parent);
    assert.equal(record.childSid, record.sid);
    assert.equal(record.custodianPgid, record.custodian);
    assert.notEqual(record.custodianPgid, record.parent);
    assert.match(record.zombieState, /^Z/u);
    assert.equal(process.kill(-record.parent, 0), true);
    const started = performance.now();
    await writeFile(join(root, "exit"), "");
    const deadline = Date.now() + 1_000;
    while ((await observeOwnedPid(record.parent)).signalProbe !== "missing" && Date.now() < deadline) {
      await delay(10);
    }
    assert.equal((await observeOwnedPid(record.parent)).signalProbe, "missing");
    assert.throws(() => process.kill(-record!.parent, 0), { code: "EPERM" });
    if (persistent) {
      const outcome = await command;
      assert.equal(readProcessFailureFacts(outcome.error)?.reason, "cleanup");
      assert.ok(outcome.error instanceof Error && isProcessRuntimeError(outcome.error.cause));
      assert.equal(outcome.error.cause.code, "cleanup");
      assert.equal(outcome.error.cause.facts.observedExit?.exitCode, 0);
      assert.equal(outcome.error.cause.facts.incompleteCustody, true);
      const nativeCause = outcome.error.cause.cause;
      assert.ok(nativeCause instanceof Error);
      assert.ok("code" in nativeCause && "syscall" in nativeCause);
      assert.equal(nativeCause.code, "EPERM");
      assert.equal(nativeCause.syscall, "kill");
      assert.ok(performance.now() - started >= 900, "retained EPERM must be observed before rejection");
      assert.ok(performance.now() - started < 2_500, "retained group observation must stay bounded");
      assert.throws(() => process.kill(-record!.parent, 0), { code: "EPERM" });
    } else {
      await delay(100);
      const premature = settlement.settled ? await command : undefined;
      assert.equal(settlement.settled, false, JSON.stringify(describeDarwinFailure(premature?.error)));
      await writeFile(join(root, "release"), "");
      const outcome = await command;
      assert.equal(outcome.error, undefined);
      assert.ok(outcome.value);
      assert.equal(outcome.value.exitCode, 0);
      assert.equal(outcome.value.stdout, "READY\n");
      assert.equal(outcome.value.stderr, "");
      assert.throws(() => process.kill(-record!.parent, 0), { code: "ESRCH" });
    }
  } finally {
    await writeFile(join(root, "release"), "");
    await writeFile(join(root, "exit"), "");
    await command;
    await waitForFixtureMarker(join(root, "reaped.json"), new Promise<ManagedProcessResult>(() => { /* Readiness is observed through the custodian marker. */ }), 5_000);
    reaped = JSON.parse(await readFile(join(root, "reaped.json"), "utf8")) as { waited: number; status: number; groupProbe: string };
    if (record !== undefined) {
      assert.equal(reaped.waited, record.child);
    }
    assert.equal(reaped.status, 0);
    assert.equal(reaped.groupProbe, "ESRCH");
    const custodian = record?.custodian ?? (JSON.parse(await readFile(join(root, "custodian.json"), "utf8")) as { custodian: number }).custodian;
    assert.ok(Number.isSafeInteger(custodian) && custodian > 0);
    const deadline = Date.now() + 5_000;
    while ((await observeOwnedPid(custodian)).signalProbe !== "missing" && Date.now() < deadline) {
      await delay(10);
    }
    assert.equal((await observeOwnedPid(custodian)).signalProbe, "missing", "TEST custodian must retire too");
  }
  return Object.freeze({ persistent, record: Object.freeze(record), reaped: Object.freeze(reaped), observedExit: 0, cleanup: persistent ? "rejected-with-debt" : "retired-after-reap" });
}
