import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { observeGet, type ObservationBudget } from "./observation-transport.ts";
import {
  admitAuthoritySelection,
  assertCurrentAuthority,
  parseAuthorityRevision,
  type AuthoritySelection,
} from "./authority-selection.ts";
import {
  initializeCampaignRoots,
  observationChildEnvironment,
  observationHeaders,
  ownedDirectory,
} from "./owned-root.ts";

export type Row = Record<string, unknown>;
export interface SelectedFile {
  readonly path: string;
  readonly sha256: string;
}
export interface BootstrapResult {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly evidenceRoot: string;
  readonly sourceRoot: string;
  readonly centralRoot: string;
  readonly controllerInstallation: string;
  readonly node24Executable: string;
  readonly node26Executable: string;
  readonly corepackEntrypoint: string;
  readonly candidate: SelectedFile;
  readonly targetLock: SelectedFile;
  readonly environment: Readonly<Record<string, string>>;
  readonly sourceRevision: string;
  readonly authorityRevision: string;
  readonly authorityTree: string;
  readonly sourceTree: string;
  readonly sourceOwner: Row;
  readonly controllerArchivesVerification: readonly Row[];
  readonly prerequisiteGeneration: string;
  readonly retainedInputs: readonly Row[];
  readonly hostRepository: "agent-teams-ai/extension-foundation";
  readonly hostRepositoryId: 1333298097;
  readonly hostRevision: string;
  readonly harnessRevision: string;
  readonly harnessTree: string;
  readonly producerPreflight: Row;
}
export const sourceRevision = "8c16e5dbf24d8a09d9f33fe7c3ee8f38bf74599c";
export const sourceTree = "026e5c38b568e4a0ff9aa3487f996671accc303a";
export const authorityRevision = parseAuthorityRevision(process.env["EF70_AUTHORITY_REVISION"]);
export const sourceOrigin = "https://github.com/agent-teams-ai/extension-foundation.git";
export const authorityOrigin = "https://github.com/agent-teams-ai/.github.git";
export const cohort = "docs-2026-11-27-stable35";
export const candidateDigest = "9e5f2f19bb14b98526672af89b8accdc1ffef3ce999e9cb41ea51ab702fb71c6";
export const selectedLockDigest =
  "121a0dff6707c5e78f4776b95bc94c4c79fb0fa0173c3581e01346469f9b5d15";
export const toolsRoot = dirname(fileURLToPath(import.meta.url));
export const producerRoot = resolve(toolsRoot, "../..");
export const fixtures = join(toolsRoot, "fixtures");
export const roots = initializeCampaignRoots();
export const rawRoot = join(roots.evidenceRoot, "bootstrap");
mkdirSync(rawRoot, { mode: 0o700 });
const observationBudget: ObservationBudget = { remainingWaitMs: 68 * 60_000 };
let commandIndex = 0;
export const selectedEnvironment: Record<string, string> = {};
export const frozen = [
  "pnpm",
  "install",
  "--frozen-lockfile",
  "--ignore-scripts",
  "--ignore-pnpmfile",
  "--package-import-method=copy",
  "--verify-store-integrity",
] as const;

export function row(value: unknown, label: string): Row {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), label);
  return value as Row;
}
export function text(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0 && !/[\0\r\n]/u.test(value), label);
  return value;
}
export function list(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), label);
  return value;
}
export function json(path: string): Row {
  return row(JSON.parse(readFileSync(path, "utf8")), path);
}
export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function fileHash(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024),
      hash = createHash("sha256");
    let count: number;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) !== 0) {
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}
export function selected(path: string): SelectedFile {
  assert(isAbsolute(path) && resolve(path) === path);
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink());
  return { path, sha256: "sha256:" + fileHash(path) };
}
export function retain(name: string, bytes: Uint8Array | string): string {
  assert(/^[a-z0-9][a-z0-9.-]*$/u.test(name));
  const path = join(rawRoot, name);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return path;
}
export function record(name: string, value: unknown): string {
  return retain(name + ".json", JSON.stringify(value, null, 2) + "\n");
}
export function command(
  label: string,
  executable: string,
  args: readonly string[],
  cwd: string,
  delta: NodeJS.ProcessEnv = {},
): Buffer {
  assert(/^[a-z0-9-]+$/u.test(label) && isAbsolute(executable) && isAbsolute(cwd));
  const startedAt = new Date().toISOString(),
    stem = String(++commandIndex) + "-" + label;
  const environment = observationChildEnvironment({
    ...process.env,
    ...selectedEnvironment,
    ...delta,
  });
  const result = spawnSync(executable, args, {
    cwd,
    env: environment,
    shell: false,
    timeout: 15 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? Buffer.alloc(0),
    stderr = result.stderr ?? Buffer.alloc(0);
  retain(stem + ".stdout", stdout);
  retain(stem + ".stderr", stderr);
  record(stem, {
    label,
    executable,
    arguments: args,
    cwd,
    startedAt,
    finishedAt: new Date().toISOString(),
    pid: result.pid,
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    scope: "Actual invocation. No automatic retry or descendant termination inference.",
  });
  assert(
    !result.error && result.signal === null && result.status === 0,
    "Bootstrap invocation failed: " + stem,
  );
  return stdout;
}
export function git(root: string, label: string, args: readonly string[]): string {
  return command(label, "/usr/bin/git", args, root).toString("utf8").trimEnd();
}
export async function fetchObserved(
  url: string,
  label: string,
  maximum = 8 * 1024 * 1024,
): Promise<Buffer> {
  const parsed = new URL(url);
  return observeGet(
    { url: parsed, headers: observationHeaders(parsed), label, maximum },
    observationBudget,
    {
      request: fetch,
      now: Date.now,
      wait: async (milliseconds) => {
        await wait(milliseconds);
        console.log(
          "EF70 bootstrap observation: waited " +
            milliseconds +
            " ms for the recorded provider backoff.",
        );
      },
      capture: (bytes, observation) => {
        const stem = observation.successful ? label : label + "-attempt-" + observation.attempt;
        retain(stem + ".raw", bytes);
        record(stem + "-transport", { ...observation, sha256: sha256(bytes) });
      },
      captureWait: (observation) => {
        record(label + "-attempt-" + observation.attempt + "-wait", observation);
        console.log(
          "EF70 bootstrap observation: " +
            label +
            " response retained; waiting until " +
            observation.notBefore,
        );
      },
    },
  );
}
export async function github(path: string, label: string): Promise<Row> {
  return row(
    JSON.parse(
      (await fetchObserved("https://api.github.com/repos/agent-teams-ai/" + path, label)).toString(
        "utf8",
      ),
    ),
    label,
  );
}
export async function assertAuthority(label: string): Promise<void> {
  const branch = await github(".github/branches/main", label);
  assertCurrentAuthority(authorityRevision, branch);
}
export async function selectAuthority(): Promise<AuthoritySelection> {
  const branch = await github(".github/branches/main", "authority-before");
  assertCurrentAuthority(authorityRevision, branch);
  const commit = await github(
    ".github/git/commits/" + authorityRevision,
    "authority-selected-commit",
  );
  const authority = admitAuthoritySelection(authorityRevision, branch, commit);
  record("authority-selection", {
    ...authority,
    origin: authorityOrigin,
    currentBranch: selected(join(rawRoot, "authority-before.raw")),
    immutableCommit: selected(join(rawRoot, "authority-selected-commit.raw")),
    scope:
      "Explicit immutable input admitted against protected Central main; fixed for this execution, never rebound.",
  });
  return authority;
}
export function clone(
  label: string,
  origin: string,
  destination: string,
  revision: string,
  tree: string,
): void {
  assert(!existsSync(destination) && dirname(destination) === roots.root);
  command(label + "-init", "/usr/bin/git", ["init", destination], roots.root);
  git(destination, label + "-origin", ["remote", "add", "origin", origin]);
  git(destination, label + "-fetch", ["fetch", "--no-tags", "--depth=1", "origin", revision]);
  git(destination, label + "-checkout", ["checkout", "--detach", revision]);
  assert.equal(git(destination, label + "-head", ["rev-parse", "HEAD"]), revision);
  assert.equal(git(destination, label + "-tree", ["rev-parse", "HEAD^{tree}"]), tree);
  assert.equal(git(destination, label + "-url", ["remote", "get-url", "origin"]), origin);
  assert.equal(
    git(destination, label + "-clean", ["status", "--porcelain=v1", "--untracked-files=no"]),
    "",
  );
  ownedDirectory(destination);
}
export function trackedImages(root: string, label: string): Row[] {
  const names = command(label + "-paths", "/usr/bin/git", ["ls-files", "-z"], root)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .toSorted();
  assert(names.length > 0 && names.length < 10_000);
  return names.map((name) => {
    assert(!isAbsolute(name) && !name.split("/").includes(".."));
    const path = join(root, name),
      stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), "Unexpected tracked image: " + name);
    return { path: name, bytes: stat.size, mode: stat.mode & 0o777, sha256: fileHash(path) };
  });
}
export function retainInstall(root: string, label: string, expectedCount: number): void {
  const modules = join(root, "node_modules"),
    virtual = join(modules, ".pnpm");
  ownedDirectory(modules);
  ownedDirectory(virtual);
  const names = readdirSync(virtual)
    .filter((name) => name !== "node_modules" && lstatSync(join(virtual, name)).isDirectory())
    .toSorted();
  assert.equal(names.length, expectedCount, "Actual installed package count: " + label);
  retain(label + "-modules.yaml", readFileSync(join(modules, ".modules.yaml")));
  retain(label + "-lock.yaml", readFileSync(join(virtual, "lock.yaml")));
  record(label + "-installation", {
    root,
    modules,
    packageCount: names.length,
    packages: names,
    scope: "Actual metadata-only frozen installation; no old Foundation execution.",
  });
}
export function retireFixtureModules(root: string, label: string): void {
  assert.equal(dirname(root), roots.root);
  assert(["source-8c16", "target-cache-fixture"].includes(relative(roots.root, root)));
  const names = command(
    label + "-gitignored-module-roots",
    "/usr/bin/git",
    ["ls-files", "--others", "--ignored", "--directory", "--exclude-standard", "-z"],
    root,
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((name) => name.replace(/\/$/u, ""))
    .filter((name) => name.split("/").at(-1) === "node_modules");
  assert(names.includes("node_modules"));
  const selectedRoots = names
    .map((name) => {
      assert(!isAbsolute(name) && !name.split("/").includes(".."));
      const path = resolve(root, name);
      assert(path.startsWith(root + sep));
      ownedDirectory(path);
      const stat = lstatSync(path);
      return { path, device: stat.dev, inode: stat.ino, ownerUID: stat.uid };
    })
    .toSorted((a, b) => b.path.length - a.path.length);
  record(label + "-module-retirement-selection", selectedRoots);
  for (const entry of selectedRoots) {
    const current = lstatSync(entry.path);
    assert.equal(current.dev, entry.device);
    assert.equal(current.ino, entry.inode);
    assert.equal(current.uid, entry.ownerUID);
    ownedDirectory(entry.path);
    rmSync(entry.path, { recursive: true, force: false });
    assert(!existsSync(entry.path));
  }
  record(label + "-modules-retired", {
    roots: selectedRoots,
    reason:
      "Fresh offline installation must not reuse installed modules; only this disposable cache fixture is retired.",
  });
}
export function installedFiles(packageRoot: string): Row[] {
  ownedDirectory(packageRoot);
  const files: Row[] = [];
  function visit(directory: string): void {
    for (const name of readdirSync(directory).toSorted()) {
      const path = join(directory, name),
        stat = lstatSync(path);
      assert(!stat.isSymbolicLink(), "Unexpected installed package link");
      if (stat.isDirectory()) {
        visit(path);
      } else {
        assert(stat.isFile() && stat.nlink === 1 && stat.size <= 32 * 1024 * 1024);
        assert(files.length < 4096);
        files.push({
          path: relative(packageRoot, path),
          mode: stat.mode & 0o777,
          sha256: fileHash(path),
          bytes: stat.size,
        });
      }
    }
  }
  visit(packageRoot);
  return files.toSorted((a, b) =>
    text(a["path"], "File path") < text(b["path"], "File path") ? -1 : 1,
  );
}
export function invoke(module: Row, name: string, args: readonly unknown[]): unknown {
  const implementation = module[name];
  assert(typeof implementation === "function", "Missing owning implementation: " + name);
  const result: unknown = Reflect.apply(implementation, undefined, args);
  return result;
}
export interface HostedRuntime {
  readonly node24: string;
  readonly node26: string;
  readonly npmEntrypoint: string;
  readonly harnessRevision: string;
  readonly hostRevision: string;
  readonly harnessTree: string;
  readonly runtime: readonly Row[];
}
