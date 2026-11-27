import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type Row = Record<string, unknown>;
export interface SelectedFile {
  readonly path: string;
  readonly sha256: string;
}
export interface Case {
  readonly name: string;
  readonly root: string;
  readonly evidence: string;
  readonly selection: Row;
}
export interface PreparedCase extends Case {
  readonly preparation: SelectedFile;
}
export interface HelperResult {
  readonly output: string;
  readonly result: Row;
}
export interface CommandResult {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly pid: number;
}
export interface FileImage {
  readonly path: string;
  readonly kind: "file" | "symlink";
  readonly mode: number;
  readonly sha256: string;
}

export interface CommandOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly accepted?: readonly number[];
}
export interface RecordedCommand {
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly accepted: readonly number[];
  readonly observer: boolean;
  readonly stem: string;
  readonly timeoutMs?: number;
}

export function row(value: unknown, label: string): Row {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), label);
  return value as Row;
}
export function text(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0 && !value.includes("\0"), label);
  return value;
}
export function jsonFile(path: string): Row {
  return row(JSON.parse(readFileSync(path, "utf8")), path);
}
export function digest(content: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
export function fileDigest(path: string): string {
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256"),
      buffer = Buffer.allocUnsafe(1024 * 1024);
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
      hash.update(buffer.subarray(0, count));
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    closeSync(fd);
  }
}
export function absolute(value: unknown, label: string): string {
  const path = text(value, label);
  assert(isAbsolute(path) && resolve(path) === path, `${label}: canonical absolute path`);
  return path;
}
export function contained(parent: string, child: string): void {
  const path = relative(parent, child);
  assert(
    path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`),
    `Expected an owned descendant of ${parent}: ${child}`,
  );
}
export function newJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

/** Records one real child invocation without retrying or inferring process settlement. */
export function executeCommand(request: RecordedCommand): CommandResult {
  const {
    label,
    executable,
    args,
    cwd,
    environment,
    accepted,
    observer,
    stem,
    timeoutMs = 960_000,
  } = request;
  assert(/^[a-z0-9][a-z0-9-]{0,150}$/u.test(label), label);
  assert(isAbsolute(executable) && isAbsolute(cwd));
  const actualEnvironment = { ...environment };
  if (!observer) {
    for (const key of [
      "EF70_GITHUB_READ_TOKEN",
      "EF_CAMPAIGN_GITHUB_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "NODE_AUTH_TOKEN",
    ]) {
      delete actualEnvironment[key];
    }
  }
  const startedAt = new Date().toISOString();
  const result = spawnSync(executable, args, {
    cwd,
    env: actualEnvironment,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  const stdout = result.stdout ?? Buffer.alloc(0),
    stderr = result.stderr ?? Buffer.alloc(0);
  writeFileSync(`${stem}.stdout`, stdout, { flag: "wx", mode: 0o600 });
  writeFileSync(`${stem}.stderr`, stderr, { flag: "wx", mode: 0o600 });
  newJson(`${stem}.json`, {
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
    stdoutDigest: digest(stdout),
    stderrDigest: digest(stderr),
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
    observerTokenRetainedForObserverOnly: observer,
    timeoutMs,
    timeoutScope:
      "A timeout or abnormal exit fails this invocation; no retry or process-tree completion is inferred.",
  });
  assert(
    !result.error &&
      result.signal === null &&
      result.status !== null &&
      accepted.includes(result.status),
    `Command ${label} failed; retained evidence ${stem}.json`,
  );
  return { status: result.status, stdout, stderr, pid: result.pid };
}
