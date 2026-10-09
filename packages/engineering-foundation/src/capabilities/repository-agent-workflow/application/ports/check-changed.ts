import type { RepositoryChangesReader } from "./changed-workflow.js";
import type { CoverageCheck, CoverageExecution, WorkflowCoveragePolicy } from "../model/check-changed.js";

/** Preserve bounded execution history when admission is revoked after launch.
 * No raw error/output or qualified facets cross this failure boundary. */
export class CoverageExecutionFailure extends Error {
  readonly execution: CoverageExecution;
  constructor(execution: CoverageExecution, readonly admissionRevoked: boolean) {
    super("Check execution failed or its admission was revoked.");
    this.execution = Object.freeze({ ...execution, qualifiedFacets: Object.freeze([]), observation: null });
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
  acquire(input: { readonly consumerRoot: string; readonly configPath: string; readonly signal?: AbortSignal }): Promise<CheckInputLease>;
}
export interface CoverageCheckRunner {
  run(input: {
    readonly lease: CheckInputLease;
    readonly check: CoverageCheck;
    readonly signal?: AbortSignal;
  }): Promise<CoverageExecution>;
}
export interface CheckChangedDependencies {
  readonly custody: CheckInputCustody;
  readonly runner: CoverageCheckRunner;
  readonly loadPolicy: (root: string, configPath: string, signal?: AbortSignal) => Promise<WorkflowCoveragePolicy>;
  readonly writeReport: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}
