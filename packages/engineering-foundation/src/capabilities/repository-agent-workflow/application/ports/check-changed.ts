import type { RepositoryChangesReader } from "./changed-workflow.js";
import type { RepositoryPackageManager } from "../../../../process-execution/application/runtime-selection.js";
import type {
  CoverageCheck,
  CoverageExecution,
  WorkflowCoveragePolicy,
} from "../model/check-changed.js";

/** Preserve bounded execution history when admission is revoked after launch.
 * Callers must pass bounded output: this boundary freezes it but does not
 * truncate raw text, and no raw error or qualified facets cross it. */
export class CoverageExecutionFailure extends Error {
  readonly execution: CoverageExecution;
  constructor(
    execution: CoverageExecution,
    readonly admissionRevoked: boolean,
  ) {
    super("Check execution failed or its admission was revoked.");
    this.execution = Object.freeze({
      ...execution,
      qualifiedFacets: Object.freeze([]),
      observation: null,
      commands: Object.freeze(execution.commands.map((command) => Object.freeze({ ...command }))),
      binding: Object.freeze({ ...execution.binding }),
    });
  }
}

/** Typed input-custody revocation: the observed input set drifted from the
 * lease identity. Distinct from execution failures so unexpected errors are
 * never relabeled as stale input. */
export class InputRevocationError extends Error {
  constructor() {
    super("Input custody observation changed.");
  }
}

/** Host owns enforcement, the entire influencing closure, outputs, and release.
 * Hash brackets alone never implement this precondition. Acquire before reading
 * config or Git scope; finish all extraction/bootstrap writes before acquire. */
export interface CheckInputLease {
  readonly executionRoot: string;
  readonly classification: "frozen-closure" | "cooperating-exclusive" | "mutable";
  readonly sourceIdentity: string;
  readonly configIdentity: string;
  readonly closureIdentity: string;
  readonly changesReader: RepositoryChangesReader;
  assertCurrent(signal?: AbortSignal): Promise<void>;
  release(): Promise<void>;
}
export interface CheckInputCustody {
  acquire(input: {
    readonly consumerRoot: string;
    readonly configPath: string;
    readonly signal?: AbortSignal;
  }): Promise<CheckInputLease>;
}
export interface CoverageCheckRunner {
  run(input: {
    readonly lease: CheckInputLease;
    readonly check: CoverageCheck;
    readonly packageManager: RepositoryPackageManager;
    readonly signal?: AbortSignal;
  }): Promise<CoverageExecution>;
}
export interface CheckChangedDependencies {
  readonly custody: CheckInputCustody;
  readonly runner: CoverageCheckRunner;
  readonly loadPolicy: (
    root: string,
    configPath: string,
    signal?: AbortSignal,
  ) => Promise<WorkflowCoveragePolicy>;
  readonly writeReport: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}
