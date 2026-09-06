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

import { assertBaselineObservationActive, assertExpectedBaselineState, baselineObservationFailure, isBaselineInputFailure, rejectBaselineWrite } from "../../../application/policies/architecture-decision-baseline-input.js";
import type { ArchitectureDecisionBaselineObservation } from "../../../application/ports/architecture-decision-baseline-observation.js";
import { parseAcceptedArchitectureDecisionBaseline } from "../../../application/policies/accepted-architecture-decision-baseline.js";
import type {
  ArchitectureDecisionBaselineExpectedState,
  ArchitectureDecisionBaselineReadResult,
  ArchitectureDecisionBaselineRepository,
  ArchitectureDecisionBaselineWriteResult
} from "../../../application/ports/architecture-decision-baseline-repository.js";
import type { AcceptedArchitectureDecisionBaseline } from "../../../application/model/architecture-decision.js";

const MAX_BASELINE_BYTES = 4 * 1024 * 1024;
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
  repositoryPath: string,
  observation: ArchitectureDecisionBaselineObservation
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
  if (await observation.pathTraversesSymbolicLink(root, candidate)) {
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
}, observation: ArchitectureDecisionBaselineObservation): Promise<InspectedBaseline> {
  assertBaselineObservationActive(input.signal);
  const target = await targetFor(input.consumerRoot, input.path, observation);
  if (targetIsReadResult(target)) {
    return { result: target };
  }
  let bytes: Buffer;
  try {
    bytes = await observation.read({
      candidate: target.candidate,
      maxBytes: MAX_BASELINE_BYTES,
      root: target.root
    });
  } catch (error) {
    return { result: baselineObservationFailure(error, MAX_BASELINE_BYTES), target };
  }
  try {
    const source = bytes.toString("utf8");
    assertBaselineObservationActive(input.signal);
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
    if (isBaselineInputFailure(error)) {
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

async function ensureSafeParent(
  target: BaselineTarget,
  observation: ArchitectureDecisionBaselineObservation
): Promise<void> {
  if (!contained(target.root, target.parent)) {
    rejectBaselineWrite(
      "ARCHITECTURE_DECISION_BASELINE_WRITE_ESCAPE",
      "Accepted-decision baseline parent escapes the consumer repository."
    );
  }
  if (await observation.pathTraversesSymbolicLink(target.root, target.parent)) {
    rejectBaselineWrite(
      "ARCHITECTURE_DECISION_BASELINE_WRITE_SYMLINK_PROHIBITED",
      "Accepted-decision baseline parent traverses a symbolic link."
    );
  }
  try {
    await mkdir(target.parent, { mode: 0o755, recursive: true });
    if (await observation.pathTraversesSymbolicLink(target.root, target.parent)) {
      rejectBaselineWrite(
        "ARCHITECTURE_DECISION_BASELINE_WRITE_SYMLINK_PROHIBITED",
        "Accepted-decision baseline parent traverses a symbolic link."
      );
    }
    const canonicalParent = await realpath(target.parent);
    if (!contained(target.root, canonicalParent) || !(await stat(canonicalParent)).isDirectory()) {
      rejectBaselineWrite(
        "ARCHITECTURE_DECISION_BASELINE_WRITE_ESCAPE",
        "Accepted-decision baseline parent is not a contained directory."
      );
    }
  } catch (error) {
    if (isBaselineInputFailure(error)) {
      throw error;
    }
    rejectBaselineWrite(
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
    rejectBaselineWrite(
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
    rejectBaselineWrite(
      "ARCHITECTURE_DECISION_BASELINE_WRITE_DURABILITY_FAILED",
      "Accepted-decision baseline was replaced but its parent directory could not be flushed. Reconcile the baseline before retrying."
    );
  }
}

export class FilesystemArchitectureDecisionBaselineRepository
  implements ArchitectureDecisionBaselineRepository
{
  constructor(private readonly observation: ArchitectureDecisionBaselineObservation) {}

  async read(input: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<ArchitectureDecisionBaselineReadResult> {
    return (await inspectBaseline(input, this.observation)).result;
  }

  async write(input: {
    readonly baseline: AcceptedArchitectureDecisionBaseline;
    readonly consumerRoot: string;
    readonly expected: ArchitectureDecisionBaselineExpectedState;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<ArchitectureDecisionBaselineWriteResult> {
    assertBaselineObservationActive(input.signal);
    const validatedBaseline = parseAcceptedArchitectureDecisionBaseline(input.baseline);
    if (validatedBaseline === undefined) {
      rejectBaselineWrite(
        "ARCHITECTURE_DECISION_BASELINE_WRITE_INVALID_INPUT",
        "Accepted-decision baseline does not match the required immutable baseline shape."
      );
    }
    const source = serializedBaseline(validatedBaseline);
    if (Buffer.byteLength(source, "utf8") > MAX_BASELINE_BYTES) {
      rejectBaselineWrite(
        "ARCHITECTURE_DECISION_BASELINE_WRITE_TOO_LARGE",
        `Accepted-decision baseline must serialize to no more than ${MAX_BASELINE_BYTES} bytes.`
      );
    }
    const firstRead = await inspectBaseline(input, this.observation);
    assertExpectedBaselineState(firstRead.result, input.expected);
    const target = firstRead.target;
    if (target === undefined) {
      rejectBaselineWrite(
        "ARCHITECTURE_DECISION_BASELINE_WRITE_UNAVAILABLE",
        "Accepted-decision baseline target is unavailable."
      );
    }
    await ensureSafeParent(target, this.observation);
    const release = await acquireBaselineWriteLock(target);
    try {
      // The lock is held across the final revision check and atomic replacement.
      // Otherwise two cooperative writers can both pass the check, then one
      // silently replaces the other while both report success.
      await ensureSafeParent(target, this.observation);
      const secondRead = await inspectBaseline(input, this.observation);
      assertExpectedBaselineState(secondRead.result, input.expected);
      if (hasEquivalentSerializedBaseline(secondRead.source, source)) {
        return "unchanged";
      }
      assertBaselineObservationActive(input.signal);
      const temporaryDirectory = await mkdtemp(
        join(target.parent, ".architecture-decision-baseline-")
      );
      try {
        const temporaryPath = join(temporaryDirectory, "baseline.json");
        await writeAndFlushTemporaryBaseline({ path: temporaryPath, source });
        assertBaselineObservationActive(input.signal);
        const finalRead = await inspectBaseline(input, this.observation);
        assertExpectedBaselineState(finalRead.result, input.expected);
        if (hasEquivalentSerializedBaseline(finalRead.source, source)) {
          return "unchanged";
        }
        if (await this.observation.pathTraversesSymbolicLink(target.root, target.candidate)) {
          rejectBaselineWrite(
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
