import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { digest, evidence, utf8, type JsonRecord } from "../stage-a/io.ts";
import { bytes } from "./context.ts";

export interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly session: number;
  readonly state: string;
  readonly start: string;
}
export interface ProcessSample extends ProcessIdentity {
  readonly observedAt: string;
  readonly executable: string;
  readonly cwd: string;
  readonly arguments: readonly string[];
  readonly selectedEnvironment: Readonly<Record<string, string>>;
}
export function absent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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
    if (absent(error)) {
      return undefined;
    }
    throw error;
  }
}
export function processTable(): readonly ProcessIdentity[] {
  const names = readdirSync("/proc").filter((name) => /^[1-9][0-9]*$/u.test(name));
  if (names.length > 8192) {
    throw new Error("Process observation exceeds its explicit bound.");
  }
  return names.map((name) => identity(Number(name))).filter((value) => value !== undefined);
}
export function sample(selected: ProcessIdentity): ProcessSample | undefined {
  try {
    const argv = readFileSync(`/proc/${selected.pid}/cmdline`);
    const environment = readFileSync(`/proc/${selected.pid}/environ`);
    if (argv.length > 128 * 1024 || environment.length > 1024 * 1024) {
      throw new Error("Process observation is overlong.");
    }
    const selectedEnvironment: Record<string, string> = {};
    for (const entry of utf8(environment).split("\0")) {
      const index = entry.indexOf("="),
        key = entry.slice(0, index);
      if (["pnpm_config_store_dir", "COREPACK_HOME", "COREPACK_ENABLE_NETWORK"].includes(key)) {
        selectedEnvironment[key] = entry.slice(index + 1);
      }
    }
    const value = {
      ...selected,
      observedAt: new Date().toISOString(),
      executable: realpathSync(`/proc/${selected.pid}/exe`),
      cwd: realpathSync(`/proc/${selected.pid}/cwd`),
      arguments: utf8(argv).split("\0").filter(Boolean),
      selectedEnvironment,
    };
    return identity(selected.pid)?.start === selected.start ? value : undefined;
  } catch (error) {
    if (absent(error)) {
      return undefined;
    }
    throw error;
  }
}
export function external(path: string, roots: readonly string[]): void {
  for (const root of roots) {
    const relation = relative(root, path);
    if (
      relation === "" ||
      (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
    ) {
      throw new Error("Selected external path overlaps a protected root.");
    }
  }
}
export function fileState(path: string, label: string): JsonRecord {
  try {
    const stat = lstatSync(path);
    const kind = stat.isSymbolicLink()
      ? "symlink"
      : stat.isFile()
        ? "file"
        : stat.isDirectory()
          ? "directory"
          : "other";
    if (kind !== "file") {
      return {
        path,
        kind,
        mode: stat.mode & 0o777,
        dev: stat.dev,
        ino: stat.ino,
        ...(kind === "symlink" ? { target: readlinkSync(path) } : {}),
      };
    }
    const content = bytes(path);
    evidence(label, content);
    return {
      path,
      kind,
      mode: stat.mode & 0o777,
      dev: stat.dev,
      ino: stat.ino,
      bytes: content.length,
      sha256: digest(content),
    };
  } catch (error) {
    if (absent(error)) {
      return { path, kind: "absent" };
    }
    throw error;
  }
}
export function treeState(
  root: string,
  label: string,
  retainBytes: boolean,
): readonly JsonRecord[] {
  const entries: JsonRecord[] = [];
  let total = 0;
  function visit(path: string, name: string, depth: number): void {
    if (depth > 16 || entries.length >= 2048) {
      throw new Error("Local evidence exceeds capture bounds.");
    }
    const stat = lstatSync(path);
    const kind = stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : "other";
    const entry: JsonRecord = {
      path: name,
      kind,
      mode: stat.mode & 0o777,
      dev: stat.dev,
      ino: stat.ino,
    };
    entries.push(entry);
    if (kind === "directory") {
      for (const child of readdirSync(path).toSorted()) {
        visit(join(path, child), `${name}/${child}`, depth + 1);
      }
    } else if (kind === "file") {
      const content = bytes(path);
      total += content.length;
      if (total > 64 * 1024 * 1024) {
        throw new Error("Local evidence exceeds byte bound.");
      }
      Object.assign(entry, { bytes: content.length, sha256: digest(content) });
      if (retainBytes) {
        evidence(`${label}/${name}`, content);
      }
    } else if (kind === "symlink") {
      entry["target"] = readlinkSync(path);
    }
  }
  try {
    visit(root, "root", 0);
  } catch (error) {
    if (entries.length === 0 && absent(error)) {
      return [{ path: "root", kind: "absent" }];
    }
    throw error;
  }
  return entries;
}

export function backupNames(consumer: string): readonly string[] {
  return readdirSync(consumer)
    .filter((name) => name.startsWith(".docs-consumer-upgrade-modules-"))
    .toSorted();
}
export function installedState(consumer: string, phase: string): JsonRecord {
  const manifests = [
    "@agent-teams/repository-mutation",
    "@agent-teams/document-authoring",
    "@agent-teams/docs-protocol",
    "@agent-teams/docs-protocol-agent-teams",
    "@agent-teams/engineering-foundation",
  ].map((name) =>
    fileState(
      join(consumer, "node_modules", name, "package.json"),
      `installation/${phase}/${name}/package.json`,
    ),
  );
  const modules = fileState(
    join(consumer, "node_modules"),
    `installation/${phase}/unexpected-node-modules.bin`,
  );
  const backups = backupNames(consumer).map((name) => ({
    name,
    metadata: fileState(join(consumer, name), `installation/${phase}/${name}.bin`),
    entries: readdirSync(join(consumer, name)).toSorted(),
  }));
  return {
    modules,
    manifests,
    backups,
    rootEntries: readdirSync(consumer).toSorted(),
    scope:
      "Root identity and selected package manifests only; not a full installed-file digest inventory.",
  };
}

export function descendantProcesses(
  table: readonly ProcessIdentity[],
  root: number,
): readonly ProcessIdentity[] {
  const selected = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of table) {
      if (selected.has(entry.ppid) && !selected.has(entry.pid)) {
        selected.add(entry.pid);
        changed = true;
      }
    }
  }
  return table.filter((value) => selected.has(value.pid));
}
