import { createHash } from "node:crypto";
import { observeAtomicFileReplacement } from "@agent-teams/repository-mutation/node";
import {
  mkdir,
  realpath,
  stat
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { baselineReplacementOperations, replaceArchitectureDecisionBaseline, type BaselineReplacementOperations, type BaselineTarget } from "./architecture-decision-baseline-replacement.js";

import { assertBaselineObservationActive, assertExpectedBaselineState, baselineObservationFailure, baselineWriteObservationFailure, isBaselineInputFailure, rejectBaselineWrite } from "../../../application/policies/architecture-decision-baseline-input.js";
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
  return { candidate, parent: dirname(candidate), root, replacement: await observeAtomicFileReplacement({ root, candidate }) };
}

function targetIsReadResult(
  value: BaselineTarget | ArchitectureDecisionBaselineReadResult
): value is ArchitectureDecisionBaselineReadResult {
  return "kind" in value;
}

async function inspectBaseline(
  input: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  },
  observation: ArchitectureDecisionBaselineObservation,
  observationFailure: typeof baselineObservationFailure = baselineObservationFailure,
  boundTarget?: BaselineTarget
): Promise<InspectedBaseline> {
  assertBaselineObservationActive(input.signal);
  const target = boundTarget ?? await targetFor(input.consumerRoot, input.path, observation);
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
    return { result: observationFailure(error, MAX_BASELINE_BYTES), target };
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

export class FilesystemArchitectureDecisionBaselineRepository
  implements ArchitectureDecisionBaselineRepository
{
  constructor(
    private readonly observation: ArchitectureDecisionBaselineObservation,
    private readonly replacementOperations: BaselineReplacementOperations = baselineReplacementOperations
  ) {}

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
    const firstRead = await inspectBaseline(input, this.observation, baselineWriteObservationFailure);
    assertExpectedBaselineState(firstRead.result, input.expected);
    const target = firstRead.target;
    if (target === undefined) {
      rejectBaselineWrite(
        "ARCHITECTURE_DECISION_BASELINE_WRITE_UNAVAILABLE",
        "Accepted-decision baseline target is unavailable."
      );
    }
    return replaceArchitectureDecisionBaseline({
      expected: input.expected,
      source,
      target,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ensureParent: () => ensureSafeParent(target, this.observation),
      inspect: () => inspectBaseline(input, this.observation, baselineWriteObservationFailure, target),
      pathTraversesSymbolicLink: () => this.observation.pathTraversesSymbolicLink(target.root, target.candidate)
    }, this.replacementOperations);
  }
}
