import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { lock } from "proper-lockfile";

import { CapabilityInputError } from "../../../../../capability-runtime.js";
import {
  ContainedFileReadError,
  pathTraversesSymbolicLink,
  readContainedRegularFile
} from "../../../../../filesystem-path-safety.js";
import { assertNotCancelled } from "../../../../../strict-yaml.js";
import { parseAcceptedArchitectureDecisionBaseline } from "../../../application/policies/accepted-architecture-decision-baseline.js";
import type {
  ArchitectureDecisionBaselineExpectedState,
  ArchitectureDecisionBaselineReadResult,
  ArchitectureDecisionBaselineRepository,
  ArchitectureDecisionBaselineWriteResult
} from "../../../application/ports/architecture-decision-baseline-repository.js";
import type { AcceptedArchitectureDecisionBaseline } from "../../../application/model/architecture-decision.js";

const MAX_BASELINE_BYTES = 4 * 1024 * 1024;
const WRITE_PHASE = "architecture-decision-baseline-write";
const BASELINE_LOCK_OPTIONS = Object.freeze({
  realpath: false,
  retries: {
    factor: 1.2,
    maxTimeout: 100,
    minTimeout: 25,
    retries: 30
  },
  stale: 30_000,
  update: 10_000
});

interface BaselineTarget {
  readonly candidate: string;
  readonly parent: string;
  readonly root: string;
}

interface InspectedBaseline {
  readonly result: ArchitectureDecisionBaselineReadResult;
  readonly source?: string;
  readonly target?: BaselineTarget;
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  );
}

function revision(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function serializedBaseline(baseline: AcceptedArchitectureDecisionBaseline): string {
  return `${JSON.stringify(
    {
      schemaVersion: baseline.schemaVersion,
      algorithm: baseline.algorithm,
      decisions: baseline.decisions.map((entry) => ({
        id: entry.id,
        path: entry.path,
        immutableDigest: entry.immutableDigest
      }))
    },
    null,
    2
  )}\n`;
}

function hasEquivalentSerializedBaseline(
  observed: string | undefined,
  expected: string
): boolean {
  return observed?.replaceAll("\r\n", "\n") === expected;
}

function writeError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: WRITE_PHASE,
    retryable: false
  });
}

async function canonicalRoot(consumerRoot: string): Promise<string | undefined> {
  try {
    const root = await realpath(consumerRoot);
    return (await stat(root)).isDirectory() ? root : undefined;
  } catch {
    return undefined;
  }
}

async function targetFor(
  consumerRoot: string,
  repositoryPath: string
): Promise<BaselineTarget | ArchitectureDecisionBaselineReadResult> {
  const root = await canonicalRoot(consumerRoot);
  if (root === undefined) {
    return { kind: "unsafe", message: "Consumer root is not available." };
  }
  const candidate = resolve(root, repositoryPath);
  if (!contained(root, candidate)) {
    return {
      kind: "unsafe",
      message: "Accepted-decision baseline path escapes the consumer repository."
    };
  }
  if (await pathTraversesSymbolicLink(root, candidate)) {
    return {
      kind: "unsafe",
      message: "Accepted-decision baseline path traverses a symbolic link."
    };
  }
  return { candidate, parent: dirname(candidate), root };
}

function targetIsReadResult(
  value: BaselineTarget | ArchitectureDecisionBaselineReadResult
): value is ArchitectureDecisionBaselineReadResult {
  return "kind" in value;
}

async function inspectBaseline(input: {
  readonly consumerRoot: string;
  readonly path: string;
  readonly signal?: AbortSignal;
}): Promise<InspectedBaseline> {
  assertNotCancelled(input.signal);
  const target = await targetFor(input.consumerRoot, input.path);
  if (targetIsReadResult(target)) {
    return { result: target };
  }
  let bytes: Buffer;
  try {
    bytes = await readContainedRegularFile({
      candidate: target.candidate,
      maxBytes: MAX_BASELINE_BYTES,
      root: target.root
    });
  } catch (error) {
    if (error instanceof ContainedFileReadError) {
      if (error.failure === "missing") {
        return { result: { kind: "missing" }, target };
      }
      if (error.failure === "invalid") {
        return {
          result: {
            kind: "invalid",
            message: `Accepted-decision baseline must be a regular JSON file no larger than ${MAX_BASELINE_BYTES} bytes.`
          },
          target
        };
      }
      return {
        result: {
          kind: "unsafe",
          message: "Accepted-decision baseline is unavailable, unsafe, or changed while reading."
        },
        target
      };
    }
    throw error;
  }
  try {
    const source = bytes.toString("utf8");
    assertNotCancelled(input.signal);
    return {
      result: {
        kind: "valid",
        revision: revision(source),
        value: JSON.parse(source) as unknown
      },
      source,
      target
    };
  } catch (error) {
    if (error instanceof CapabilityInputError) {
      throw error;
    }
    return {
      result: {
        kind: "invalid",
        message: "Accepted-decision baseline is not valid JSON."
      },
      target
    };
  }
}

function assertExpectedState(
  current: ArchitectureDecisionBaselineReadResult,
  expected: ArchitectureDecisionBaselineExpectedState
): void {
  if (current.kind === "unsafe") {
    writeError(
      "ARCHITECTURE_DECISION_BASELINE_WRITE_UNSAFE_TARGET",
      `Accepted-decision baseline target is unsafe: ${current.message}`
    );
  }
  if (current.kind === "invalid") {
    writeError(
      "ARCHITECTURE_DECISION_BASELINE_WRITE_INVALID_TARGET",
      `Accepted-decision baseline target is invalid: ${current.message}`
    );
  }
  if (expected.kind === "missing" && current.kind === "missing") {
    return;
  }
  if (
    expected.kind === "valid" &&
    current.kind === "valid" &&
    current.revision === expected.revision
  ) {
    return;
  }
  writeError(
    "ARCHITECTURE_DECISION_BASELINE_WRITE_CONFLICT",
    "Accepted-decision baseline changed, appeared, or became unavailable during promotion. Re-run promotion from the current repository state."
  );
}

async function ensureSafeParent(target: BaselineTarget): Promise<void> {
  if (!contained(target.root, target.parent)) {
    writeError(
      "ARCHITECTURE_DECISION_BASELINE_WRITE_ESCAPE",
      "Accepted-decision baseline parent escapes the consumer repository."
    );
  }
  if (await pathTraversesSymbolicLink(target.root, target.parent)) {
    writeError(
      "ARCHITECTURE_DECISION_BASELINE_WRITE_SYMLINK_PROHIBITED",
      "Accepted-decision baseline parent traverses a symbolic link."
    );
  }
  try {
    await mkdir(target.parent, { mode: 0o755, recursive: true });
    if (await pathTraversesSymbolicLink(target.root, target.parent)) {
      writeError(
        "ARCHITECTURE_DECISION_BASELINE_WRITE_SYMLINK_PROHIBITED",
        "Accepted-decision baseline parent traverses a symbolic link."
      );
    }
    const canonicalParent = await realpath(target.parent);
    if (!contained(target.root, canonicalParent) || !(await stat(canonicalParent)).isDirectory()) {
      writeError(
        "ARCHITECTURE_DECISION_BASELINE_WRITE_ESCAPE",
        "Accepted-decision baseline parent is not a contained directory."
      );
    }
  } catch (error) {
    if (error instanceof CapabilityInputError) {
      throw error;
    }
    writeError(
      "ARCHITECTURE_DECISION_BASELINE_WRITE_UNAVAILABLE",
      "Accepted-decision baseline parent cannot be created safely."
    );
  }
}

async function acquireBaselineWriteLock(
  target: BaselineTarget
): Promise<() => Promise<void>> {
  try {
    // This is a cooperative lock. The repeated revision check below still detects
    // direct filesystem mutation that does not participate in the protocol.
    return await lock(target.candidate, BASELINE_LOCK_OPTIONS);
  } catch {
    writeError(
      "ARCHITECTURE_DECISION_BASELINE_WRITE_LOCK_UNAVAILABLE",
      "Accepted-decision baseline is currently being promoted by another writer. Re-run promotion from the current repository state."
    );
  }
}

async function writeAndFlushTemporaryBaseline(input: {
  readonly path: string;
  readonly source: string;
}): Promise<void> {
  const handle = await open(input.path, "w", 0o644);
  try {
    await handle.writeFile(input.source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function flushParentDirectory(parent: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  try {
    const handle = await open(parent, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    writeError(
      "ARCHITECTURE_DECISION_BASELINE_WRITE_DURABILITY_FAILED",
      "Accepted-decision baseline was replaced but its parent directory could not be flushed. Reconcile the baseline before retrying."
    );
  }
}

export class FilesystemArchitectureDecisionBaselineRepository
  implements ArchitectureDecisionBaselineRepository
{
  async read(input: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<ArchitectureDecisionBaselineReadResult> {
    return (await inspectBaseline(input)).result;
  }

  async write(input: {
    readonly baseline: AcceptedArchitectureDecisionBaseline;
    readonly consumerRoot: string;
    readonly expected: ArchitectureDecisionBaselineExpectedState;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<ArchitectureDecisionBaselineWriteResult> {
    assertNotCancelled(input.signal);
    const validatedBaseline = parseAcceptedArchitectureDecisionBaseline(input.baseline);
    if (validatedBaseline === undefined) {
      writeError(
        "ARCHITECTURE_DECISION_BASELINE_WRITE_INVALID_INPUT",
        "Accepted-decision baseline does not match the required immutable baseline shape."
      );
    }
    const source = serializedBaseline(validatedBaseline);
    if (Buffer.byteLength(source, "utf8") > MAX_BASELINE_BYTES) {
      writeError(
        "ARCHITECTURE_DECISION_BASELINE_WRITE_TOO_LARGE",
        `Accepted-decision baseline must serialize to no more than ${MAX_BASELINE_BYTES} bytes.`
      );
    }
    const firstRead = await inspectBaseline(input);
    assertExpectedState(firstRead.result, input.expected);
    const target = firstRead.target;
    if (target === undefined) {
      writeError(
        "ARCHITECTURE_DECISION_BASELINE_WRITE_UNAVAILABLE",
        "Accepted-decision baseline target is unavailable."
      );
    }
    await ensureSafeParent(target);
    const release = await acquireBaselineWriteLock(target);
    try {
      // The lock is held across the final revision check and atomic replacement.
      // Otherwise two cooperative writers can both pass the check, then one
      // silently replaces the other while both report success.
      await ensureSafeParent(target);
      const secondRead = await inspectBaseline(input);
      assertExpectedState(secondRead.result, input.expected);
      if (hasEquivalentSerializedBaseline(secondRead.source, source)) {
        return "unchanged";
      }
      assertNotCancelled(input.signal);
      const temporaryDirectory = await mkdtemp(
        join(target.parent, ".architecture-decision-baseline-")
      );
      try {
        const temporaryPath = join(temporaryDirectory, "baseline.json");
        await writeAndFlushTemporaryBaseline({ path: temporaryPath, source });
        assertNotCancelled(input.signal);
        const finalRead = await inspectBaseline(input);
        assertExpectedState(finalRead.result, input.expected);
        if (hasEquivalentSerializedBaseline(finalRead.source, source)) {
          return "unchanged";
        }
        if (await pathTraversesSymbolicLink(target.root, target.candidate)) {
          writeError(
            "ARCHITECTURE_DECISION_BASELINE_WRITE_SYMLINK_PROHIBITED",
            "Accepted-decision baseline target traverses a symbolic link."
          );
        }
        await rename(temporaryPath, target.candidate);
        await flushParentDirectory(target.parent);
        return input.expected.kind === "missing" ? "created" : "updated";
      } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
      }
    } finally {
      await release();
    }
  }
}
