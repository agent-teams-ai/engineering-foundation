import { open, mkdir, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { lock } from "proper-lockfile";

import { CapabilityInputError } from "../../../../../../capability-runtime.js";
import { assertNotCancelled } from "../../../../../../cancellation.js";
import {
  ContainedFileReadError,
  pathTraversesSymbolicLink,
  readContainedRegularFile
} from "../../../../../../filesystem-path-safety.js";
import type {
  BufQualificationArtifacts,
  BufQualificationEvidenceWriteResult
} from "../../../ports/buf-qualification-artifacts.js";

const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const WRITE_LOCK_OPTIONS = Object.freeze({
  realpath: false,
  retries: 0,
  stale: 30_000,
  update: 10_000
});
const WRITE_LOCK_RETRIES = 30;
const WRITE_LOCK_MIN_DELAY_MS = 25;
const WRITE_LOCK_MAX_DELAY_MS = 100;
const WRITE_LOCK_BACKOFF = 1.2;

interface WriteTarget {
  readonly candidate: string;
  readonly parent: string;
  readonly parentDevice: string;
  readonly parentInode: string;
  readonly root: string;
}

interface ExistingEvidence {
  readonly exists: boolean;
  readonly source?: string;
}

function inputError(code: string, message: string): never {
  throw qualificationError(code, message);
}

function qualificationError(code: string, message: string): CapabilityInputError {
  return new CapabilityInputError({
    code,
    message,
    phase: "protobuf-buf-qualification-artifacts",
    retryable: false
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  );
}

function readFailure(error: ContainedFileReadError, path: string, optional: boolean): never | undefined {
  if (optional && error.failure === "missing") {
    return undefined;
  }
  inputError(
    error.failure === "symlink" || error.failure === "escape"
      ? "BUF_QUALIFICATION_PATH_UNSAFE"
      : "BUF_QUALIFICATION_INPUT_UNAVAILABLE",
    `Qualification artifact is unavailable, unsafe, or changed while reading: ${path}.`
  );
}

async function readContained(input: {
  readonly consumerRoot: string;
  readonly path: string;
  readonly maxBytes: number;
  readonly optional: boolean;
}): Promise<Buffer | undefined> {
  try {
    return await readContainedRegularFile({
      candidate: resolve(input.consumerRoot, input.path),
      maxBytes: input.maxBytes,
      root: input.consumerRoot
    });
  } catch (error) {
    if (!(error instanceof ContainedFileReadError)) {
      throw error;
    }
    readFailure(error, input.path, input.optional);
    return undefined;
  }
}

async function assertSafeCandidate(target: WriteTarget): Promise<void> {
  if (
    (await pathTraversesSymbolicLink(target.root, target.parent)) ||
    (await pathTraversesSymbolicLink(target.root, target.candidate))
  ) {
    inputError("BUF_QUALIFICATION_PATH_UNSAFE", "Evidence target cannot traverse a symbolic link.");
  }
  const canonicalParent = await realpath(target.parent);
  const parentMetadata = await stat(canonicalParent, { bigint: true });
  if (
    canonicalParent !== target.parent ||
    !contained(target.root, canonicalParent) ||
    !parentMetadata.isDirectory() ||
    String(parentMetadata.dev) !== target.parentDevice ||
    String(parentMetadata.ino) !== target.parentInode
  ) {
    inputError("BUF_QUALIFICATION_PATH_UNSAFE", "Evidence directory identity changed during qualification.");
  }
  try {
    const metadata = await stat(target.candidate);
    if (!metadata.isFile()) {
      inputError("BUF_QUALIFICATION_PATH_UNSAFE", "Evidence target must be a regular file.");
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

async function canonicalWriteTarget(consumerRoot: string, path: string): Promise<WriteTarget> {
  const root = await realpath(consumerRoot);
  const lexicalCandidate = resolve(root, path);
  if (!contained(root, lexicalCandidate)) {
    inputError("BUF_QUALIFICATION_PATH_UNSAFE", "Evidence path escapes the consumer repository.");
  }
  const parent = dirname(lexicalCandidate);
  if (await pathTraversesSymbolicLink(root, parent)) {
    inputError("BUF_QUALIFICATION_PATH_UNSAFE", "Evidence directory cannot traverse a symbolic link.");
  }
  await mkdir(parent, { recursive: true });
  if (await pathTraversesSymbolicLink(root, parent)) {
    inputError("BUF_QUALIFICATION_PATH_UNSAFE", "Evidence directory cannot traverse a symbolic link.");
  }
  const canonicalParent = await realpath(parent);
  const parentMetadata = await stat(canonicalParent, { bigint: true });
  if (!contained(root, canonicalParent) || !parentMetadata.isDirectory()) {
    inputError("BUF_QUALIFICATION_PATH_UNSAFE", "Evidence directory escapes the consumer repository.");
  }
  const target = {
    candidate: join(canonicalParent, basename(lexicalCandidate)),
    parent: canonicalParent,
    parentDevice: String(parentMetadata.dev),
    parentInode: String(parentMetadata.ino),
    root
  };
  await assertSafeCandidate(target);
  return target;
}

async function flushParentDirectory(parent: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const directory = await open(parent, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function waitForLockRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  assertNotCancelled(signal);
  try {
    await wait(delayMs, undefined, signal === undefined ? {} : { signal });
  } catch (error) {
    assertNotCancelled(signal);
    throw error;
  }
  assertNotCancelled(signal);
}

async function acquireWriteLock(
  path: string,
  signal?: AbortSignal
): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt <= WRITE_LOCK_RETRIES; attempt += 1) {
    assertNotCancelled(signal);
    try {
      return await lock(path, WRITE_LOCK_OPTIONS);
    } catch (error) {
      if (errorCode(error) !== "ELOCKED" || attempt === WRITE_LOCK_RETRIES) {
        throw error;
      }
    }
    const delayMs = Math.min(
      WRITE_LOCK_MAX_DELAY_MS,
      WRITE_LOCK_MIN_DELAY_MS * (WRITE_LOCK_BACKOFF ** attempt)
    );
    await waitForLockRetry(delayMs, signal);
  }
  throw new Error("Unreachable write-lock retry state.");
}

async function writeAtomic(
  target: WriteTarget,
  source: string,
  signal?: AbortSignal
): Promise<void> {
  assertNotCancelled(signal);
  const expected = Buffer.from(source, "utf8");
  if (expected.length > MAX_EVIDENCE_BYTES) {
    inputError(
      "BUF_QUALIFICATION_EVIDENCE_TOO_LARGE",
      "Canonical Buf qualification evidence exceeds the supported size limit."
    );
  }
  const temporaryRoot = await mkdtemp(join(target.parent, ".buf-evidence-"));
  const temporaryPath = join(temporaryRoot, "evidence.json");
  let replaced = false;
  let durable = false;
  let failure: unknown;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(source, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    assertNotCancelled(signal);
    await assertSafeCandidate(target);
    assertNotCancelled(signal);
    await rename(temporaryPath, target.candidate);
    replaced = true;
    await assertSafeCandidate(target);
    const persisted = await readContainedRegularFile({
      candidate: target.candidate,
      maxBytes: MAX_EVIDENCE_BYTES,
      root: target.root
    });
    if (!persisted.equals(expected)) {
      inputError(
        "BUF_QUALIFICATION_WRITE_OUTCOME_UNCERTAIN",
        "Evidence bytes changed during atomic publication."
      );
    }
    await assertSafeCandidate(target);
    await flushParentDirectory(target.parent);
    durable = true;
  } catch (error) {
    if (
      replaced &&
      (!(error instanceof CapabilityInputError) ||
        error.problem.code !== "BUF_QUALIFICATION_WRITE_OUTCOME_UNCERTAIN")
    ) {
      failure = qualificationError(
        "BUF_QUALIFICATION_WRITE_OUTCOME_UNCERTAIN",
        "Evidence was replaced but final durability or containment could not be proven."
      );
    } else {
      failure = error;
    }
  }
  let cleanupFailure: unknown;
  try {
    await rm(temporaryRoot, { force: true, recursive: true });
  } catch (error) {
    cleanupFailure = error;
  }
  if (failure !== undefined) {
    throw failure;
  }
  if (cleanupFailure !== undefined) {
    if (durable) {
      inputError(
        "BUF_QUALIFICATION_POST_COMMIT_CLEANUP_FAILED",
        "Evidence was durably published, but temporary artifact cleanup failed."
      );
    }
    if (replaced) {
      inputError(
        "BUF_QUALIFICATION_WRITE_OUTCOME_UNCERTAIN",
        "Evidence was replaced, but publication completion could not be proven."
      );
    }
    throw cleanupFailure;
  }
}

async function readExistingForWrite(
  consumerRoot: string,
  path: string,
  target: WriteTarget
): Promise<ExistingEvidence> {
  let metadata;
  try {
    metadata = await stat(target.candidate);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
  if (!metadata.isFile()) {
    inputError("BUF_QUALIFICATION_PATH_UNSAFE", "Evidence target must be a regular file.");
  }
  if (metadata.size > MAX_EVIDENCE_BYTES) {
    return { exists: true };
  }
  const bytes = await readContained({
    consumerRoot,
    path,
    maxBytes: MAX_EVIDENCE_BYTES,
    optional: false
  });
  return { exists: true, ...(bytes === undefined ? {} : { source: bytes.toString("utf8") }) };
}

export class FilesystemBufQualificationArtifacts implements BufQualificationArtifacts {
  async readInput(input: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly maxBytes: number;
    readonly label: string;
  }): Promise<Uint8Array> {
    const bytes = await readContained({ ...input, optional: false });
    if (bytes === undefined) {
      inputError("BUF_QUALIFICATION_INPUT_UNAVAILABLE", `${input.label} is unavailable.`);
    }
    return bytes;
  }

  async readExistingEvidence(input: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly maxBytes: number;
  }): Promise<string | undefined> {
    const bytes = await readContained({ ...input, optional: true });
    return bytes?.toString("utf8");
  }

  async writeEvidence(input: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly source: string;
    readonly signal?: AbortSignal;
  }): Promise<BufQualificationEvidenceWriteResult> {
    assertNotCancelled(input.signal);
    const target = await canonicalWriteTarget(input.consumerRoot, input.path);
    let failed = false;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireWriteLock(target.candidate, input.signal);
      assertNotCancelled(input.signal);
      await assertSafeCandidate(target);
      const existing = await readExistingForWrite(
        input.consumerRoot,
        input.path,
        target
      );
      if (existing.source === input.source) {
        return "unchanged";
      }
      await writeAtomic(target, input.source, input.signal);
      return existing.exists ? "updated" : "created";
    } catch (error) {
      failed = true;
      if (error instanceof CapabilityInputError) {
        throw error;
      }
      return inputError(
        "BUF_QUALIFICATION_WRITE_UNAVAILABLE",
        "Buf qualification evidence could not be locked or replaced safely."
      );
    } finally {
      try {
        await release?.();
      } catch {
        if (!failed) {
          inputError(
            "BUF_QUALIFICATION_LOCK_RELEASE_FAILED",
            "Evidence was published but its cooperative write lock could not be released."
          );
        }
      }
    }
  }
}
