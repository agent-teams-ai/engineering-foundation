import type { AgentInstructionPaths, AgentWorkflowScripts } from "./repository-agent-workflow.js";
import type { RepositoryChanges } from "./changed-workflow.js";

export type CoverageFacet = "lint" | "typecheck" | "tests" | "standards" | "architecture";
export interface CoverageCheck {
  readonly id: string;
  readonly script: string;
  readonly prerequisites: readonly string[];
  readonly supplies: readonly CoverageFacet[];
  readonly observation: "command" | "test-dispatch/v1";
}
export interface WorkflowCoveragePolicy {
  readonly schemaVersion: 2;
  readonly instructions: AgentInstructionPaths;
  readonly scripts: AgentWorkflowScripts;
  readonly scopes: readonly {
    readonly id: string;
    readonly roots: readonly string[];
    readonly requiredFacets: readonly CoverageFacet[];
    readonly checks: readonly string[];
  }[];
  readonly checks: readonly CoverageCheck[];
  readonly exclusions: readonly { readonly path: string; readonly reason: string }[];
  readonly escalationCheck: string;
}
export interface ObservationBinding {
  readonly invocationId: string;
  readonly sourceIdentity: string;
  readonly configIdentity: string;
  readonly checkId: string;
}
export interface TestDispatchObservation extends ObservationBinding {
  readonly schemaVersion: 1;
  readonly runnerIdentity: string;
  readonly selectedSuites: readonly string[];
  readonly executed: number;
  readonly skipped: number;
  readonly outcome: "passed" | "empty-selection" | "failed" | "cancelled";
}
export interface CoverageExecution {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly cancelled: boolean;
  readonly output: string;
  readonly qualifiedFacets: readonly CoverageFacet[];
  readonly observation: TestDispatchObservation | null;
  readonly binding: ObservationBinding;
  /** null means the executor rejected without an observed exit status. */
  readonly commands: readonly { readonly script: string; readonly exitCode: number | null; readonly durationMs: number }[];
}
export interface CoverageRow {
  readonly path: string;
  readonly facet: CoverageFacet | null;
  readonly state: "checked" | "explicitly-skipped" | "uncovered" | "stale";
  readonly reason: string;
  readonly checkIds: readonly string[];
}
export interface CheckChangedReport {
  readonly reportSchemaVersion: 2;
  readonly outcome: "passed" | "feedback-only" | "not-checked" | "uncovered" | "failed" | "cancelled" | "stale";
  readonly reason: string;
  readonly source: RepositoryChanges | null;
  readonly base: { readonly requestedRef: string | null; readonly resolvedRef: string; readonly commit: string | null; readonly mergeBaseCommit: string | null } | null;
  readonly head: { readonly ref: "HEAD"; readonly commit: string | null } | null;
  readonly scopeDigest: string | null;
  readonly changeGroups: RepositoryChanges["changeGroups"] | null;
  readonly inputCustody: {
    readonly classification: "frozen-closure" | "cooperating-exclusive" | "mutable";
    readonly sourceIdentity: string;
    readonly configIdentity: string;
    readonly closureIdentity: string;
    readonly binding: "qualified-host-precondition" | "unverified";
    readonly limitation: string;
  };
  readonly plannedChecks: readonly { readonly id: string; readonly target: "repository"; readonly reason: string }[];
  readonly steps: readonly (CoverageExecution & { readonly id: string; readonly script: string })[];
  readonly coverage: readonly CoverageRow[];
}
