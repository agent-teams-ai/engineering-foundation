import { readFileSync, readdirSync, realpathSync } from "node:fs";

export interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly session: number;
  readonly state: string;
  readonly start: string;
}
export function identity(pid: number): ProcessIdentity | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return {
      pid,
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
      session: Number(fields[3]),
      state: fields[0]!,
      start: fields[19]!,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
export function descendants(root: number): readonly ProcessIdentity[] {
  const observed = readdirSync("/proc")
    .filter((name) => /^[1-9][0-9]*$/u.test(name))
    .map((name) => identity(Number(name)))
    .filter((entry) => entry !== undefined);
  const selected = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of observed) {
      if (selected.has(entry.ppid) && !selected.has(entry.pid)) {
        selected.add(entry.pid);
        changed = true;
      }
    }
  }
  return observed.filter((entry) => selected.has(entry.pid));
}

export interface RuntimeProbeSelection {
  readonly controllerPid: number;
  readonly executable: string;
  readonly cwd: string;
  readonly arguments: readonly string[];
}
export function isRuntimeProbe(entry: ProcessIdentity, selection: RuntimeProbeSelection): boolean {
  const pid = selection.controllerPid;
  if (entry.ppid !== pid || entry.pgid !== pid || entry.session !== pid) {
    return false;
  }
  try {
    const argv = readFileSync(`/proc/${entry.pid}/cmdline`, "utf8").split("\0");
    if (argv.at(-1) === "") {
      argv.pop();
    }
    return (
      JSON.stringify(argv) === JSON.stringify(selection.arguments) &&
      realpathSync(`/proc/${entry.pid}/exe`) === selection.executable &&
      realpathSync(`/proc/${entry.pid}/cwd`) === selection.cwd
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
export function currentRuntimeProbe(selection: RuntimeProbeSelection): ProcessIdentity | undefined {
  const matches = readdirSync("/proc")
    .filter((name) => /^[1-9][0-9]*$/u.test(name))
    .map((name) => identity(Number(name)))
    .filter((entry) => entry !== undefined)
    .filter((entry) => isRuntimeProbe(entry, selection));
  if (matches.length > 1) {
    throw new Error("Runtime probe ownership is ambiguous.");
  }
  return matches[0];
}
