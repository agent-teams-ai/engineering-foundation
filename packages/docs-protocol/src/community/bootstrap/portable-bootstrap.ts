import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  applyKnownFileTransaction,
  compileKnownFileTransactionPlan,
  inspectKnownFileTransactionBarrier,
  recoverKnownFileTransaction,
  type KnownFileTransactionOperationInput,
  type KnownFileTransactionPlanV1,
  type KnownFileTransactionReceiptV1
} from "@agent-teams/engineering-foundation/mutation";
import { DOCS_ADOPTION_MAX_ROUTING_BYTES } from "../../domain/model.js";
import {
  PORTABLE_BOOTSTRAP_BEGIN_MARKER,
  PORTABLE_BOOTSTRAP_END_MARKER,
  portableBootstrapDesiredFiles,
  portableBootstrapManagedBlock,
  type PortableBootstrapDesiredFile
} from "./portable-bootstrap-assets.js";

const MAXIMUM_OBSERVED_FILE_BYTES = 8 * 1024 * 1024;
const MAXIMUM_ROOT_LENGTH = 4096, MAXIMUM_PROJECT_ID_LENGTH = 160, MAXIMUM_OWNER_ID_LENGTH = 214;
const PROJECT_ID = /^[a-z0-9][a-z0-9._/-]*$/u;
const OWNER_ID = /^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/u;

type PortableBootstrapMode = "dry-run" | "apply";
type PortableBootstrapWriteState = "blocked" | "create" | "current" | "replace";

interface PortableBootstrapInput {
  readonly consumerRoot: string;
  readonly mode: PortableBootstrapMode;
  readonly ownerId: string;
  readonly projectId: string;
}

interface ApplyPortableBootstrapInput extends PortableBootstrapInput {
  readonly expectedPlanDigest: `sha256:${string}`;
  readonly mode: "apply";
}

interface PortableBootstrapFilePlan {
  readonly ownership: "create-only" | "managed-block";
  readonly path: string;
  readonly writeState: PortableBootstrapWriteState;
}

interface PortableBootstrapIssue {
  readonly code:
    | "PORTABLE_BOOTSTRAP_AGENTS_TOO_LARGE"
    | "PORTABLE_BOOTSTRAP_CONFLICT"
    | "PORTABLE_BOOTSTRAP_INVALID_AGENTS_MARKERS";
  readonly message: string;
  readonly path: string;
}

export interface PortableBootstrapPlan {
  readonly schemaVersion: 1;
  readonly protocol: "agent-teams.docs-protocol.portable-bootstrap/v1";
  readonly mode: PortableBootstrapMode;
  readonly outcome: "blocked" | "change-required" | "current";
  readonly planDigest: `sha256:${string}`;
  readonly files: readonly PortableBootstrapFilePlan[];
  readonly issues: readonly PortableBootstrapIssue[];
  readonly transactionPlan?: KnownFileTransactionPlanV1;
}

interface PortableBootstrapExecution {
  readonly outcome: "applied" | "current";
  readonly plan: PortableBootstrapPlan;
  readonly receipt: KnownFileTransactionReceiptV1;
}

function assertCanonicalId(
  value: string,
  name: "ownerId" | "projectId",
  pattern: RegExp,
  maximumLength: number
): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
    value.normalize("NFC") !== value || !pattern.test(value) || value.startsWith("/") ||
    value.endsWith("/") || value.includes("//") || value.split("/").some((part) =>
      part === "." || part === ".."
    )) {
    throw new TypeError(`${name} must be one bounded canonical identifier.`);
  }
}

function assertInput(input: PortableBootstrapInput): void {
  if (Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("Portable bootstrap input must be a plain object.");
  }
  if (typeof input.consumerRoot !== "string" || input.consumerRoot.length === 0 ||
    input.consumerRoot.length > MAXIMUM_ROOT_LENGTH || input.consumerRoot.includes("\u0000")) {
    throw new TypeError("consumerRoot must be one bounded filesystem path.");
  }
  if (input.mode !== "dry-run" && input.mode !== "apply") {
    throw new TypeError("mode must be dry-run or apply.");
  }
  assertCanonicalId(input.projectId, "projectId", PROJECT_ID, MAXIMUM_PROJECT_ID_LENGTH);
  assertCanonicalId(input.ownerId, "ownerId", OWNER_ID, MAXIMUM_OWNER_ID_LENGTH);
}

function sameIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameObservation(
  left: BigIntStats,
  right: BigIntStats
): boolean {
  return sameIdentity(left, right) &&
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink &&
    left.size === right.size;
}

async function readAtMost(handle: FileHandle): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAXIMUM_OBSERVED_FILE_BYTES) {
    const remaining = MAXIMUM_OBSERVED_FILE_BYTES + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) {return Buffer.concat(chunks, total);}
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return undefined;
}

async function readObservedHandle(
  handle: FileHandle,
  path: string
): Promise<{ readonly bytes: Buffer; readonly mode: number }> {
  const opened = await handle.stat({ bigint: true });
  if (!opened.isFile()) {
    throw new TypeError(`Portable bootstrap target must be a real regular file: ${path}.`);
  }
  if (opened.nlink !== 1n) {
    throw new TypeError(`Portable bootstrap target must not have multiple hard links: ${path}.`);
  }
  if (opened.size > BigInt(MAXIMUM_OBSERVED_FILE_BYTES)) {
    throw new TypeError(`Portable bootstrap target exceeds the bounded read limit: ${path}.`);
  }
  const bytes = await readAtMost(handle);
  if (bytes === undefined) {
    throw new TypeError(`Portable bootstrap target exceeds the bounded read limit: ${path}.`);
  }
  const after = await handle.stat({ bigint: true });
  const physical = await realpath(path).catch(() => null);
  const pathState = physical === path
    ? await lstat(path, { bigint: true }).catch(() => null)
    : null;
  if (!after.isFile() || after.nlink !== 1n || !sameObservation(opened, after) ||
    after.size !== BigInt(bytes.byteLength) || pathState === null ||
    pathState.isSymbolicLink() || !pathState.isFile() || pathState.nlink !== 1n ||
    !sameObservation(after, pathState)) {
    throw new TypeError(`Portable bootstrap target changed during read: ${path}.`);
  }
  return { bytes, mode: Number(after.mode & 0o777n) };
}

async function canonicalConsumerRoot(consumerRoot: string): Promise<string> {
  const requested = resolve(consumerRoot);
  const physical = await realpath(requested);
  const [requestedMetadata, physicalMetadata] = await Promise.all([
    lstat(requested, { bigint: true }),
    lstat(physical, { bigint: true })
  ]);
  if (requestedMetadata.isSymbolicLink() || !requestedMetadata.isDirectory() ||
    physicalMetadata.isSymbolicLink() || !physicalMetadata.isDirectory() ||
    !sameIdentity(requestedMetadata, physicalMetadata)) {
    throw new TypeError("Portable bootstrap consumerRoot must be one real directory, not a symlink.");
  }
  return physical;
}

async function containedTarget(root: string, repositoryPath: string): Promise<string | undefined> {
  const segments = repositoryPath.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const identity = segment.normalize("NFC").toLowerCase();
    const entries = await readdir(current);
    const matches = entries.filter((entry) => entry.normalize("NFC").toLowerCase() === identity);
    if (matches.some((entry) => entry !== segment)) {
      throw new TypeError(`Portable bootstrap target has a case or Unicode path alias: ${repositoryPath}.`);
    }
    if (!matches.includes(segment)) {return undefined;}
    const next = join(current, segment);
    if (index === segments.length - 1) {return next;}
    const metadata = await lstat(next);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(next) !== next) {
      throw new TypeError(`Portable bootstrap target has an unsafe repository ancestor: ${repositoryPath}.`);
    }
    current = next;
  }
  return undefined;
}

async function observe(root: string, repositoryPath: string): Promise<{ readonly bytes: Buffer; readonly mode: number } | undefined> {
  const path = await containedTarget(root, repositoryPath);
  if (path === undefined) {return undefined;}
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const nonBlocking = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  const handle = await open(path, constants.O_RDONLY | noFollow | nonBlocking).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new TypeError(`Portable bootstrap target must be a real regular file: ${path}.`);
    }
    throw error;
  });
  if (handle === null) {return undefined;}
  try {
    return await readObservedHandle(handle, path);
  } finally {
    await handle.close();
  }
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function portablePlanDigest(
  input: {
    readonly desired: readonly PortableBootstrapDesiredFile[];
    readonly files: readonly PortableBootstrapFilePlan[];
    readonly issues: readonly PortableBootstrapIssue[];
    readonly ownerId: string;
    readonly projectId: string;
    readonly transactionPlan: KnownFileTransactionPlanV1 | undefined;
  }
): `sha256:${string}` {
  const body = JSON.stringify({
    protocol: "agent-teams.docs-protocol.portable-bootstrap/v1",
    projectId: input.projectId,
    ownerId: input.ownerId,
    files: input.desired.map(({ bytes, ownership, path }) => ({
      path,
      ownership,
      digest: createHash("sha256").update(bytes).digest("hex")
    })),
    agentsManagedBlockDigest: createHash("sha256").update(portableBootstrapManagedBlock("\n")).digest("hex"),
    observedPlanDigest: input.transactionPlan?.planDigest ?? null,
    observations: input.files.map(({ ownership, path, writeState }) => ({ ownership, path, writeState })),
    issues: input.issues
  });
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function planCreateOnlyFile(
  file: PortableBootstrapDesiredFile,
  current: { readonly bytes: Buffer; readonly mode: number } | undefined
): {
  readonly file: PortableBootstrapFilePlan;
  readonly issue?: PortableBootstrapIssue;
  readonly operation?: KnownFileTransactionOperationInput;
} {
  if (current === undefined) {
    return {
      file: { path: file.path, ownership: file.ownership, writeState: "create" },
      operation: {
        path: file.path,
        precondition: { state: "absent" },
        postimage: { bytes: file.bytes }
      }
    };
  }
  if (current.bytes.equals(file.bytes)) {
    return {
      file: { path: file.path, ownership: file.ownership, writeState: "current" },
      operation: {
        path: file.path,
        precondition: { state: "known-file", acceptedPreimages: [{ bytes: current.bytes, mode: current.mode }] },
        postimage: { bytes: current.bytes, mode: current.mode }
      }
    };
  }
  return {
    file: { path: file.path, ownership: file.ownership, writeState: "blocked" },
    issue: {
      code: "PORTABLE_BOOTSTRAP_CONFLICT",
      path: file.path,
      message: "A create-only bootstrap target already exists with different bytes."
    }
  };
}

function agentsSizeIssue(bytes: Uint8Array): PortableBootstrapIssue | undefined {
  return bytes.byteLength > DOCS_ADOPTION_MAX_ROUTING_BYTES ? {
    code: "PORTABLE_BOOTSTRAP_AGENTS_TOO_LARGE",
    path: "AGENTS.md",
    message: `Managed AGENTS.md postimage exceeds the ${DOCS_ADOPTION_MAX_ROUTING_BYTES} byte adoption limit.`
  } : undefined;
}

function hasExactManagedBlock(input: {
  readonly beginCount: number;
  readonly block: string;
  readonly endCount: number;
  readonly eol: string;
  readonly source: string;
}): boolean {
  const begin = input.source.indexOf(PORTABLE_BOOTSTRAP_BEGIN_MARKER);
  const end = input.source.indexOf(PORTABLE_BOOTSTRAP_END_MARKER);
  return input.beginCount === 1 && input.endCount === 1 && input.source.includes(input.block) &&
    begin < end && (begin === 0 || input.source.slice(0, begin).endsWith(input.eol)) &&
    (end + PORTABLE_BOOTSTRAP_END_MARKER.length === input.source.length ||
      input.source.slice(end + PORTABLE_BOOTSTRAP_END_MARKER.length).startsWith(input.eol));
}

function planAgentsFile(
  agents: { readonly bytes: Buffer; readonly mode: number } | undefined
): {
  readonly file: PortableBootstrapFilePlan;
  readonly issue?: PortableBootstrapIssue;
  readonly operation?: KnownFileTransactionOperationInput;
} {
  if (agents === undefined) {
    const bytes = Buffer.from(`${portableBootstrapManagedBlock("\n")}\n`, "utf8");
    return {
      file: { path: "AGENTS.md", ownership: "managed-block", writeState: "create" },
      operation: {
        path: "AGENTS.md",
        precondition: { state: "absent" },
        postimage: { bytes }
      }
    };
  }
  const currentSizeIssue = agentsSizeIssue(agents.bytes);
  if (currentSizeIssue !== undefined) {
    return {
      file: { path: "AGENTS.md", ownership: "managed-block", writeState: "blocked" },
      issue: currentSizeIssue
    };
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(agents.bytes);
  } catch {
    return {
      file: { path: "AGENTS.md", ownership: "managed-block", writeState: "blocked" },
      issue: {
        code: "PORTABLE_BOOTSTRAP_INVALID_AGENTS_MARKERS",
        path: "AGENTS.md",
        message: "AGENTS.md must be strict UTF-8 text without BOM or NUL bytes."
      }
    };
  }
  if (source.startsWith("\uFEFF") || source.includes("\u0000")) {
    return {
      file: { path: "AGENTS.md", ownership: "managed-block", writeState: "blocked" },
      issue: {
        code: "PORTABLE_BOOTSTRAP_INVALID_AGENTS_MARKERS",
        path: "AGENTS.md",
        message: "AGENTS.md must be strict UTF-8 text without BOM or NUL bytes."
      }
    };
  }
  const beginCount = count(source, PORTABLE_BOOTSTRAP_BEGIN_MARKER);
  const endCount = count(source, PORTABLE_BOOTSTRAP_END_MARKER);
  const eol = source.includes("\r\n") && !source.replaceAll("\r\n", "").includes("\n")
    ? "\r\n"
    : "\n";
  const block = portableBootstrapManagedBlock(eol);
  if (beginCount === 0 && endCount === 0) {
    const separator = source.length === 0 ? "" : source.endsWith(`${eol}${eol}`) ? "" :
      source.endsWith(eol) ? eol : `${eol}${eol}`;
    const postimage = Buffer.concat([agents.bytes, Buffer.from(`${separator}${block}${eol}`, "utf8")]);
    const postimageSizeIssue = agentsSizeIssue(postimage);
    if (postimageSizeIssue !== undefined) {
      return {
        file: { path: "AGENTS.md", ownership: "managed-block", writeState: "blocked" },
        issue: postimageSizeIssue
      };
    }
    return {
      file: { path: "AGENTS.md", ownership: "managed-block", writeState: "replace" },
      operation: {
        path: "AGENTS.md",
        precondition: { state: "known-file", acceptedPreimages: [{ bytes: agents.bytes, mode: agents.mode }] },
        postimage: { bytes: postimage, mode: agents.mode }
      }
    };
  }
  const exactBlock = hasExactManagedBlock({ beginCount, block, endCount, eol, source });
  if (exactBlock) {
    return {
      file: { path: "AGENTS.md", ownership: "managed-block", writeState: "current" },
      operation: {
        path: "AGENTS.md",
        precondition: { state: "known-file", acceptedPreimages: [{ bytes: agents.bytes, mode: agents.mode }] },
        postimage: { bytes: agents.bytes, mode: agents.mode }
      }
    };
  }
  return {
    file: { path: "AGENTS.md", ownership: "managed-block", writeState: "blocked" },
    issue: {
      code: "PORTABLE_BOOTSTRAP_INVALID_AGENTS_MARKERS",
      path: "AGENTS.md",
      message: "AGENTS.md contains duplicate, incomplete, or modified portable documentation markers."
    }
  };
}

export async function compilePortableBootstrap(input: PortableBootstrapInput): Promise<PortableBootstrapPlan> {
  assertInput(input);
  const root = await canonicalConsumerRoot(input.consumerRoot);
  const desired = portableBootstrapDesiredFiles(input.projectId, input.ownerId);
  const operations: KnownFileTransactionOperationInput[] = [];
  const files: PortableBootstrapFilePlan[] = [];
  const issues: PortableBootstrapIssue[] = [];

  for (const file of desired) {
    const planned = planCreateOnlyFile(file, await observe(root, file.path));
    files.push(planned.file);
    if (planned.operation !== undefined) {operations.push(planned.operation);}
    if (planned.issue !== undefined) {issues.push(planned.issue);}
  }

  const agents = planAgentsFile(await observe(root, "AGENTS.md"));
  files.push(agents.file);
  if (agents.operation !== undefined) {operations.push(agents.operation);}
  if (agents.issue !== undefined) {issues.push(agents.issue);}

  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  issues.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const transactionPlan = issues.length === 0
    ? compileKnownFileTransactionPlan({ operations })
    : undefined;
  const mutationRequired = files.some(({ writeState }) => writeState === "create" || writeState === "replace");
  const outcome = issues.length > 0 ? "blocked" : mutationRequired ? "change-required" : "current";
  const frozenFiles = Object.freeze(files.map((file) => Object.freeze(file)));
  const frozenIssues = Object.freeze(issues.map((issue) => Object.freeze(issue)));
  return Object.freeze({
    schemaVersion: 1,
    protocol: "agent-teams.docs-protocol.portable-bootstrap/v1",
    mode: input.mode,
    outcome,
    planDigest: portablePlanDigest({
      desired,
      transactionPlan,
      projectId: input.projectId,
      ownerId: input.ownerId,
      files: frozenFiles,
      issues: frozenIssues
    }),
    files: frozenFiles,
    issues: frozenIssues,
    ...(transactionPlan === undefined ? {} : { transactionPlan })
  });
}

export async function applyPortableBootstrap(input: ApplyPortableBootstrapInput): Promise<PortableBootstrapExecution> {
  if (typeof input.expectedPlanDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.expectedPlanDigest)) {
    throw new TypeError("expectedPlanDigest must be the exact digest returned by dry-run.");
  }
  const compiled = await compilePortableBootstrap(input);
  if (compiled.outcome === "blocked" || compiled.transactionPlan === undefined) {
    throw new Error("Portable bootstrap is blocked by conflicting repository files.");
  }
  if (input.expectedPlanDigest !== compiled.planDigest) {
    throw new Error(`Portable bootstrap Plan is stale: expected ${input.expectedPlanDigest}, observed ${compiled.planDigest}.`);
  }
  const receipt = await applyKnownFileTransaction({
    consumerRoot: input.consumerRoot,
    plan: compiled.transactionPlan
  });
  return Object.freeze({
    outcome: receipt.outcome === "applied" ? "applied" : "current",
    plan: compiled,
    receipt
  });
}

export async function inspectPortableBootstrap(input: { readonly consumerRoot: string }) {
  return inspectKnownFileTransactionBarrier(input);
}

export async function recoverPortableBootstrap(input: { readonly consumerRoot: string }) {
  return recoverKnownFileTransaction(input);
}
