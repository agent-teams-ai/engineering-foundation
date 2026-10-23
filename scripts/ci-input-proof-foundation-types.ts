import type { CheckCommand, ProcessReport } from "./ci-input-proof-full.mts";

export type InputProofRelation = Readonly<
  | { status: "compatible-inputs"; changedContentPaths: readonly string[] }
  | { status: "rejected"; reason: string }
>;
export type CompareInputInventories = (
  before: unknown,
  after: unknown,
  permittedContentChanges: unknown,
) => InputProofRelation;
export type InputLeafShape = Readonly<{
  path: string;
  type: "file" | "symlink" | "gitlink";
  mode: "100644" | "100755" | "120000" | "160000";
  membership: "closed" | "structural";
  content: string;
}>;
export type LeafInventoryShape = Readonly<{
  version: 1;
  digestScheme: "git-object-sha1" | "sha256";
  inputs: readonly InputLeafShape[];
}>;
export type ScopeCategory =
  | "source"
  | "helpers"
  | "fixtures"
  | "config"
  | "lock"
  | "toolchain"
  | "installedGraph";
export type Observation = Readonly<{
  schemaVersion: 1;
  boundaryId: string;
  scopeId: "foundation.ci-input-proof.focus.v1";
  scope: Readonly<Record<ScopeCategory, readonly string[]>>;
  inventory: LeafInventoryShape;
}>;
export type MergeTuple = Readonly<{
  headSha: string;
  baseSha: string;
  mergeTuple: string;
}>;
export type FoundationPilotRequest = Readonly<{
  schemaVersion: 1;
  pilotId: "foundation.ci-input-proof.focus.v1";
  tuple: MergeTuple;
  before: Observation;
  current: Observation;
  permittedContentChanges: readonly string[];
  full: CheckCommand;
}>;
export type FoundationPilotRequestInput = Readonly<{
  schemaVersion: number;
  pilotId: string;
  tuple: unknown;
  before: Observation;
  current: Observation;
  permittedContentChanges: unknown;
  full: unknown;
}>;
export type CandidateOmitObservation = Readonly<{
  status: "eligible" | "not-eligible";
  reason: string;
  relation: InputProofRelation | Readonly<{ status: "unavailable"; reason: string }>;
  observationIssues: readonly string[];
  changedContentPaths: readonly string[];
}>;
export type AdapterReport = Readonly<{
  schemaVersion: 1;
  tuple: MergeTuple & Readonly<{ digest: string }>;
  candidateOmitObservation: CandidateOmitObservation;
  execution: Readonly<{
    status: "passed" | "failed" | "unavailable";
    full: ProcessReport;
  }>;
  omission: Readonly<{
    status: "not-attempted";
    reason: "shadow-executes-full";
    reportedSeparatelyFromPass: true;
  }>;
  selection: Readonly<{
    decision: "full";
    reason: "shadow-no-admitted-omission-policy";
    independentlyExecutable: true;
  }>;
  authority: Readonly<{
    mode: "control-shadow";
    admittedOmissionPolicy: false;
    packageResolutionClosure: "unsupported";
    savedCheck: false;
  }>;
  optimizer: Readonly<{
    status: "unavailable";
    reason: "no-admitted-optimizer-policy";
    omissionAuthority: false;
  }>;
  timingsMs: Readonly<{
    comparison: number;
    optimizer: number;
    full: number;
    total: number;
    clock: "performance.now";
  }>;
}>;
export type AdapterResult = Readonly<{
  report: AdapterReport;
  exitCode: number;
}>;
