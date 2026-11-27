import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { row, type Row } from "../ef70-managed-campaign/campaign-io.ts";
import { AdoptionEvidence, errorObservation, invoke } from "./evidence.ts";
import { bytes, inventory, rootIdentity, sha256, text } from "./files.ts";

export interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly state: string;
  readonly start: string;
}
function absent(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")
  );
}
export function processIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const source = readFileSync("/proc/" + pid + "/stat", "utf8");
    assert(source.length <= 16 * 1024);
    const fields = source.slice(source.lastIndexOf(")") + 2).split(" ");
    const start = text(fields[19], "Observed process start"),
      state = text(fields[0], "Process state");
    assert(/^[0-9]+$/u.test(start) && state.length === 1);
    const ppid = Number(fields[1]);
    assert(Number.isSafeInteger(ppid) && ppid >= 0);
    return { pid, ppid, state, start };
  } catch (error) {
    if (absent(error)) {
      return undefined;
    }
    throw error;
  }
}
function observedCwd(observed: ProcessIdentity): string | undefined {
  try {
    return realpathSync("/proc/" + observed.pid + "/cwd");
  } catch (error) {
    if (!absent(error)) {
      throw error;
    }
  }
  try {
    return readlinkSync("/proc/" + observed.pid + "/cwd");
  } catch (error) {
    if (!absent(error)) {
      throw error;
    }
    const current = processIdentity(observed.pid);
    assert(
      current?.start !== observed.start || current.state === "Z",
      "A live owned-user cwd is unobservable",
    );
    return undefined;
  }
}
export function processCensus(roots: readonly string[], prior: readonly ProcessIdentity[] = []) {
  const rechecked = prior.map((previous) => ({
    previous,
    current: processIdentity(previous.pid) ?? null,
  }));
  const livePrior = rechecked.filter(({ previous, current }) => current?.start === previous.start);
  const ownedCwd: Row[] = [],
    foreignUid: Row[] = [],
    unknown: Row[] = [];
  const names = readdirSync("/proc").filter((name) => /^[1-9][0-9]*$/u.test(name));
  assert(names.length <= 8192);
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
      const cwd = observedCwd(observed);
      if (cwd === undefined || processIdentity(pid)?.start !== observed.start) {
        continue;
      }
      if (
        roots.some(
          (root) => cwd === root || cwd === root + " (deleted)" || cwd.startsWith(root + sep),
        )
      ) {
        ownedCwd.push({ process: observed, cwd });
      }
    } catch (error) {
      if (!absent(error)) {
        unknown.push({ pid, error: errorObservation(error) });
      }
    }
  }
  return {
    observedAt: new Date().toISOString(),
    roots,
    rechecked,
    livePrior,
    ownedCwd,
    foreignUid,
    unknown,
    scope:
      "Previously attributed PID/start identities plus current effective-user cwd census; not complete host/process-tree visibility.",
  };
}
export function assertNoOwnedProcesses(
  evidence: AdoptionEvidence,
  roots: readonly string[],
  label: string,
): void {
  const census = processCensus(roots);
  evidence.record(label, census);
  assert.equal(census.ownedCwd.length, 0);
  assert.equal(census.unknown.length, 0);
}
export async function requireSettled(
  evidence: AdoptionEvidence,
  prior: readonly ProcessIdentity[],
  label: string,
): Promise<void> {
  const roots = [evidence.config.consumer, evidence.config.roots.root];
  let census = processCensus(roots, prior);
  evidence.record(label + "-processes-first", census);
  const deadline = Date.now() + 10_000;
  while (
    (census.livePrior.length > 0 || census.ownedCwd.length > 0 || census.unknown.length > 0) &&
    Date.now() < deadline
  ) {
    await delay(250);
    census = processCensus(roots, prior);
  }
  evidence.record(label + "-processes-final", census);
  assert.equal(census.livePrior.length, 0, "Previously attributed process remains");
  assert.equal(census.ownedCwd.length, 0, "Owned-user process still uses selected roots");
  assert.equal(census.unknown.length, 0, "Process custody remains unobservable");
}
export async function publicBarrier(installation: string, consumer: string): Promise<Row> {
  const entrypoint = createRequire(join(installation, "package.json")).resolve(
    "@agent-teams/repository-mutation",
  );
  const kernel = row(await import(pathToFileURL(entrypoint).href), "Authenticated public kernel");
  return row(
    await invoke(kernel, "inspectKnownFileTransactionBarrier", [{ consumerRoot: consumer }]),
    "Actual public barrier",
  );
}
export function retainedDebt(evidence: AdoptionEvidence): Row {
  const { consumer, roots, environment } = evidence.config;
  const runtimeRecords: Row[] = [];
  for (const namespace of new Set([roots.root, text(environment["TMPDIR"], "Owned temp")])) {
    rootIdentity(namespace);
    const names = readdirSync(namespace);
    assert(names.length <= 8192);
    for (const name of names.filter((entry) =>
      /^managed-runtime-.*\.json(?:\.release-debt)?$/u.test(entry),
    )) {
      const path = join(namespace, name),
        content = bytes(path, 256 * 1024);
      runtimeRecords.push({
        path,
        sha256: sha256(content),
        contentBase64: content.toString("base64"),
      });
    }
  }
  const backups = readdirSync(consumer).filter((name) =>
    name.startsWith(".docs-consumer-upgrade-modules-"),
  );
  const local = join(consumer, ".agent-teams-local");
  const localImages = existsSync(local) ? inventory(local, false) : [];
  return {
    runtimeRecords,
    backups,
    localImages,
    scope:
      "Observed owned namespaces only; retained records are barriers and are never deleted by this launcher.",
  };
}
export async function requireIdle(
  evidence: AdoptionEvidence,
  installation: string,
  label: string,
): Promise<void> {
  const barrier = await publicBarrier(installation, evidence.config.consumer),
    debt = retainedDebt(evidence);
  evidence.record(label, { barrier, debt });
  assert.equal(barrier["state"], "idle", "Existing owner must reconcile the mutation barrier");
  assert.deepEqual(debt["runtimeRecords"], [], "Retained runtime attempt debt");
  assert.deepEqual(debt["backups"], [], "Retained installation backup debt");
  const reserved = new Set([
    "foundation-operation.lock",
    "scaffolding-transaction.json",
    "scaffolding-transaction.json.tmp",
    "scaffolding-transaction.json.known-file.tmp",
  ]);
  assert(Array.isArray(debt["localImages"]));
  for (const image of debt["localImages"]) {
    assert(
      !reserved.has(String(row(image, "Local image")["path"])),
      "Retained owner transaction state",
    );
  }
}
