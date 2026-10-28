import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { isProcessRuntimeError, type ProcessRunResult } from "node-or-bun";
import { assertCompleteProcessResult } from "./process.js";

export const formatFilesContractVersion = 1;
export interface FormatFilesDetails {
  readonly schemaVersion: typeof formatFilesContractVersion;
  readonly requested: readonly string[];
  readonly validated: readonly string[];
  readonly attempted: readonly string[];
  readonly digests: Readonly<Record<"requested" | "validated" | "attempted", string>>;
  readonly batches: readonly {
    readonly files: readonly string[];
    readonly completed: boolean;
    readonly result?: unknown;
  }[];
  readonly completed: boolean;
  readonly sourceBytesUnchanged: boolean | null;
  readonly retainedControlDirectory?: string;
  readonly failure?: string;
}
interface FormatInput {
  readonly cwd: string;
  readonly files: readonly string[];
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly fixedArgs: readonly string[];
}
type Invoke = (
  args: readonly string[],
  cwd: string,
  remainingMs: number,
) => Promise<ProcessRunResult>;
const extensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".md",
]);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
function remaining(input: FormatInput): number {
  if (input.signal.aborted) {
    throw new Error(
      input.signal.reason instanceof DOMException && input.signal.reason.name === "TimeoutError"
        ? "TOOLCHAIN_DEADLINE"
        : "TOOLCHAIN_CANCELLED",
    );
  }
  const value = Math.floor(input.deadline - performance.now());
  if (value <= 0) {
    throw new Error("TOOLCHAIN_DEADLINE");
  }
  return value;
}
function observe(root: string, file: string) {
  let current = root;
  for (const segment of file.split("/")) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("TOOLCHAIN_FORMAT_SYMLINK");
    }
  }
  if (!fs.lstatSync(current).isFile()) {
    throw new Error("TOOLCHAIN_FORMAT_FILE");
  }
  const fd = fs.openSync(current, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) {
      throw new Error("TOOLCHAIN_FORMAT_FILE");
    }
    const bytes = Buffer.alloc(stat.size + 1);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== stat.size) {
      throw new Error("TOOLCHAIN_FORMAT_SOURCE_CHANGED");
    }
    return {
      identity: `${stat.dev}:${stat.ino}`,
      bytes: stat.size,
      sha256: createHash("sha256").update(bytes.subarray(0, stat.size)).digest("hex"),
    };
  } finally {
    fs.closeSync(fd);
  }
}
function requestedFiles(files: readonly string[]): string[] {
  if (!Array.isArray(files) || files.length === 0 || files.length > 100_000) {
    throw new Error("TOOLCHAIN_FORMAT_FILES");
  }
  const identities = new Set<string>();
  let bytes = 0;
  const result: string[] = [];
  for (const file of files) {
    if (
      typeof file !== "string" ||
      !file ||
      !file.isWellFormed() ||
      path.isAbsolute(file) ||
      /[\\:]/u.test(file) ||
      file.split("").some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) ||
      file
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            /[. ]$/u.test(part) ||
            /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
        )
    ) {
      throw new Error("TOOLCHAIN_FORMAT_PATH");
    }
    bytes += Buffer.byteLength(file);
    const identity = file.normalize("NFC").toLowerCase();
    if (Buffer.byteLength(file) > 4096 || bytes > 2 * 1024 * 1024 || identities.has(identity)) {
      throw new Error("TOOLCHAIN_FORMAT_IDENTITY");
    }
    identities.add(identity);
    result.push(file);
  }
  return result.toSorted(compare);
}
// Twice UTF-8 bytes plus quoting bounds Windows UTF-16 quoting and POSIX argv bytes.
const argumentBytes = (value: string) => Buffer.byteLength(value) * 2 + 4;
function batches(files: readonly string[], fixedArgs: readonly string[]): string[][] {
  const result: string[][] = [];
  let batch: string[] = [];
  const overhead = fixedArgs.reduce((sum, value) => sum + argumentBytes(value), 0);
  let bytes = overhead;
  for (const file of files) {
    const size = argumentBytes(`./${file}`);
    if (overhead + size > 24 * 1024) {
      throw new Error("TOOLCHAIN_FORMAT_ARGUMENTS");
    }
    if (bytes + size > 24 * 1024) {
      result.push(batch);
      batch = [];
      bytes = overhead;
    }
    batch.push(file);
    bytes += size;
  }
  result.push(batch);
  return result;
}
const identity = (file: string) => {
  const stat = fs.lstatSync(file);
  return `${stat.dev}:${stat.ino}`;
};
function verifyControl(control: string, directoryIdentity: string, ignoreIdentity?: string): void {
  if (!fs.lstatSync(control).isDirectory() || identity(control) !== directoryIdentity) {
    throw new Error("TOOLCHAIN_FORMAT_CLEANUP");
  }
  if (ignoreIdentity !== undefined) {
    const ignore = path.join(control, "empty.ignore");
    const stat = fs.lstatSync(ignore);
    if (!stat.isFile() || stat.size !== 0 || identity(ignore) !== ignoreIdentity) {
      throw new Error("TOOLCHAIN_FORMAT_CLEANUP");
    }
  }
}
function validateFiles(
  input: FormatInput,
  root: string,
  requested: readonly string[],
  observations: Map<string, ReturnType<typeof observe>>,
): void {
  const physical = new Set<string>();
  let bytes = 0;
  for (const file of requested) {
    remaining(input);
    if (!extensions.has(path.extname(file))) {
      throw new Error("TOOLCHAIN_FORMAT_UNSUPPORTED");
    }
    const observation = observe(root, file);
    bytes += observation.bytes;
    if (physical.has(observation.identity) || bytes > 64 * 1024 * 1024) {
      throw new Error("TOOLCHAIN_FORMAT_IDENTITY");
    }
    physical.add(observation.identity);
    observations.set(file, observation);
  }
}
function verifySources(
  input: FormatInput,
  root: string,
  files: readonly string[],
  observations: ReadonlyMap<string, ReturnType<typeof observe>>,
): void {
  for (const file of files) {
    remaining(input);
    if (digest(observe(root, file)) !== digest(observations.get(file))) {
      throw new Error("TOOLCHAIN_FORMAT_SOURCE_CHANGED");
    }
  }
  remaining(input);
}
function outsideTemporaryRoot(root: string): string {
  const temporaryRoot = fs.realpathSync(tmpdir());
  const relative = path.relative(root, temporaryRoot);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    throw new Error("TOOLCHAIN_FORMAT_TEMP_ROOT");
  }
  return temporaryRoot;
}
function failureCode(error: unknown): string {
  return isProcessRuntimeError(error)
    ? `TOOLCHAIN_PROCESS_${error.code.toUpperCase()}`
    : error instanceof Error && error.message.startsWith("TOOLCHAIN_")
      ? error.message
      : "TOOLCHAIN_FORMAT_FILE";
}
function removeControl(control: string, directoryIdentity: string, ignoreIdentity?: string): void {
  verifyControl(control, directoryIdentity, ignoreIdentity);
  if (ignoreIdentity !== undefined) {
    fs.unlinkSync(path.join(control, "empty.ignore"));
  }
  fs.rmdirSync(control);
}
/** Literal execution only; the caller owns discovery and protected-input policy. */
export async function checkFormatFiles(input: FormatInput, invoke: Invoke) {
  let requested: string[] = [];
  const attempted: string[] = [];
  const records: { files: string[]; completed: boolean; result?: Awaited<ReturnType<Invoke>> }[] =
    [];
  const observations = new Map<string, ReturnType<typeof observe>>();
  let control: string | undefined;
  let controlIdentity: string | undefined;
  let ignoreIdentity: string | undefined;
  let retainControl = false;
  let unchanged: boolean | null = null;
  let completed = false;
  let failure: string | undefined;
  let exitCode = 2;
  try {
    remaining(input);
    requested = requestedFiles(input.files);
    const root = fs.realpathSync(input.cwd);
    validateFiles(input, root, requested, observations);
    control = fs.mkdtempSync(path.join(outsideTemporaryRoot(root), "stack-format-"));
    controlIdentity = identity(control);
    const ignore = path.join(control, "empty.ignore");
    fs.writeFileSync(ignore, "", { flag: "wx", mode: 0o600 });
    ignoreIdentity = identity(ignore);
    const groups = batches(requested, [...input.fixedArgs, "--ignore-path", ignore, "--"]);
    for (const files of groups) {
      remaining(input);
      verifySources(input, root, files, observations);
      const record: (typeof records)[number] = { files, completed: false };
      records.push(record);
      verifyControl(control, controlIdentity, ignoreIdentity);
      attempted.push(...files);
      let result: ProcessRunResult;
      try {
        result = await invoke(
          ["--ignore-path", ignore, "--", ...files.map((file) => `./${file}`)],
          root,
          remaining(input),
        );
      } catch (error) {
        retainControl = !isProcessRuntimeError(error) || error.incompleteCustody;
        throw error;
      }
      record.result = result;
      retainControl = result.facts.incompleteCustody;
      assertCompleteProcessResult(result);
      remaining(input);
      record.completed = result.exitCode === 0 || result.exitCode === 1;
      if (result.exitCode !== 0) {
        exitCode = result.exitCode === 1 ? 1 : 2;
        break;
      }
    }
    verifySources(input, root, requested, observations);
    unchanged = true;
    completed = records.length === groups.length && records.every((record) => record.completed);
    if (completed && records.every((record) => record.result?.exitCode === 0)) {
      exitCode = 0;
    }
  } catch (error) {
    failure = failureCode(error);
    if (failure === "TOOLCHAIN_FORMAT_SOURCE_CHANGED") {
      unchanged = false;
    }
    exitCode = 2;
  } finally {
    if (control !== undefined && !retainControl) {
      try {
        removeControl(control, controlIdentity!, ignoreIdentity);
      } catch {
        retainControl = true;
        failure ??= "TOOLCHAIN_FORMAT_CLEANUP";
        exitCode = 2;
        completed = false;
      }
    }
  }
  try {
    remaining(input);
  } catch (error) {
    failure ??= failureCode(error);
    exitCode = 2;
    completed = false;
  }
  const validated = [...observations.keys()];
  const details: FormatFilesDetails = {
    schemaVersion: formatFilesContractVersion,
    requested,
    validated,
    attempted,
    digests: {
      requested: digest(requested),
      validated: digest(validated),
      attempted: digest(attempted),
    },
    batches: records,
    completed,
    sourceBytesUnchanged: unchanged,
    // Retention is set only after creation, or inside that directory's cleanup branch.
    ...(retainControl ? { retainedControlDirectory: control! } : {}),
    ...(failure === undefined ? {} : { failure }),
  };
  return { exitCode, details };
}
