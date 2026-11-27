import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { row, text, type Campaign, type PreparedCase } from "./campaign-support.ts";
import { absent } from "./cold-custody.ts";

interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly session: number;
  readonly state: string;
  readonly start: string;
}

function processIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const raw = readFileSync("/proc/" + pid + "/stat", "utf8");
    assert(raw.length < 16 * 1024);
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    const start = fields[19],
      state = fields[0];
    assert(start !== undefined && /^[0-9]+$/u.test(start) && state?.length === 1);
    return {
      pid,
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
      session: Number(fields[3]),
      state,
      start,
    };
  } catch (error) {
    if (absent(error)) {
      return undefined;
    }
    throw error;
  }
}
export function recordedProcesses(value: unknown): readonly ProcessIdentity[] {
  assert(Array.isArray(value) && value.length > 0 && value.length <= 8192);
  return value.map((entry) => {
    const parsed = row(entry, "recorded process");
    const integer = (field: string): number => {
      const number = parsed[field];
      assert(typeof number === "number" && Number.isSafeInteger(number) && number >= 0);
      return number;
    };
    const pid = integer("pid");
    assert(pid > 0);
    const start = text(parsed["start"], "process start");
    assert(/^[0-9]+$/u.test(start));
    return {
      pid,
      ppid: integer("ppid"),
      pgid: integer("pgid"),
      session: integer("session"),
      state: text(parsed["state"], "process state"),
      start,
    };
  });
}
function processCwd(
  pid: number,
  observed: ProcessIdentity,
  unresolved: ProcessIdentity[],
): string | undefined {
  try {
    return realpathSync("/proc/" + pid + "/cwd");
  } catch (error) {
    if (!absent(error)) {
      throw error;
    }
  }
  try {
    return readlinkSync("/proc/" + pid + "/cwd");
  } catch (error) {
    if (!absent(error)) {
      throw error;
    }
    const remaining = processIdentity(pid);
    if (remaining?.start === observed.start && remaining.state !== "Z") {
      unresolved.push(remaining);
    }
    return undefined;
  }
}

function processObservation(root: string, prior: readonly ProcessIdentity[]) {
  const rechecked = prior.map((previous) => ({
    previous,
    current: processIdentity(previous.pid) ?? null,
  }));
  const livePrior = rechecked.filter(({ previous, current }) => current?.start === previous.start);
  const ownedCwd: { process: ProcessIdentity; cwd: string }[] = [];
  const foreignUid: { pid: number; uid: number }[] = [];
  const unresolvedCwd: ProcessIdentity[] = [];
  const names = readdirSync("/proc").filter((name) => /^[1-9][0-9]*$/u.test(name));
  assert(names.length <= 8192, "Process census exceeds bound");
  for (const name of names) {
    const pid = Number(name);
    try {
      const stat = lstatSync("/proc/" + name),
        observed = processIdentity(pid);
      if (observed === undefined) {
        continue;
      }
      if (stat.uid !== process.geteuid?.()) {
        foreignUid.push({ pid, uid: stat.uid });
        continue;
      }
      const cwd = processCwd(pid, observed, unresolvedCwd);
      if (cwd === undefined) {
        continue;
      }
      if (processIdentity(pid)?.start !== observed.start) {
        continue;
      }
      if (cwd === root || cwd === root + " (deleted)" || cwd.startsWith(root + sep)) {
        ownedCwd.push({ process: observed, cwd });
      }
    } catch (error) {
      if (!absent(error)) {
        throw error;
      }
    }
  }
  return {
    observedAt: new Date().toISOString(),
    rechecked,
    livePrior,
    ownedCwd,
    foreignUid,
    unresolvedCwd,
    scope:
      "Every previously attributed PID/start plus the current effective-user cwd census; no complete host/process-tree visibility claim.",
  };
}
export async function settledProcesses(
  campaign: Campaign,
  selected: PreparedCase,
  label: string,
  prior: readonly ProcessIdentity[],
): Promise<void> {
  let observation = processObservation(selected.root, prior);
  campaign.record(label + "-processes-first", observation);
  const deadline = Date.now() + 10_000;
  while (
    (observation.livePrior.length > 0 ||
      observation.ownedCwd.length > 0 ||
      observation.unresolvedCwd.length > 0) &&
    Date.now() < deadline
  ) {
    await delay(250);
    observation = processObservation(selected.root, prior);
  }
  campaign.record(label + "-processes-final", observation);
  assert.equal(
    observation.livePrior.length,
    0,
    "Attributed child remains; preserve owner evidence",
  );
  assert.equal(observation.ownedCwd.length, 0, "An owned-user process still uses the consumer");
  assert.equal(observation.unresolvedCwd.length, 0, "A live owned-user cwd could not be observed");
}
export async function idleBarrier(campaign: Campaign, root: string, label: string): Promise<void> {
  const entrypoint = createRequire(join(campaign.controllerInstallation, "package.json")).resolve(
    "@agent-teams/repository-mutation",
  );
  const exports: unknown = await import(pathToFileURL(entrypoint).href);
  const inspect = row(exports, "public kernel")["inspectKnownFileTransactionBarrier"];
  assert(typeof inspect === "function", "Public barrier inspector required");
  const observed: unknown = await Reflect.apply(inspect, undefined, [{ consumerRoot: root }]);
  const barrier = row(observed, "actual public barrier");
  campaign.record(label, barrier);
  assert.equal(barrier["state"], "idle", "Existing recovery owner must settle the RM barrier");
}
