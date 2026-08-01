export const FOUNDATION_REPORT_SCHEMA_VERSION = 1 as const;

export type FoundationOutcome =
  | "passed"
  | "violations"
  | "invalid-input"
  | "failed"
  | "cancelled";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface DiagnosticPosition {
  readonly line: number;
  readonly column: number;
}

export interface DiagnosticLocation {
  readonly path: string;
  readonly start?: DiagnosticPosition;
  readonly end?: DiagnosticPosition;
}

export interface DiagnosticEvidence {
  readonly kind: string;
  readonly value: string;
}

export interface FoundationDiagnostic {
  readonly ruleId: string;
  readonly severity: DiagnosticSeverity;
  readonly subject: string;
  readonly message: string;
  readonly location: DiagnosticLocation;
  readonly relatedLocations: readonly DiagnosticLocation[];
  readonly evidence: readonly DiagnosticEvidence[];
  readonly remediation: string;
  readonly requiresArchitectureReview: boolean;
}

export interface FoundationProblem {
  readonly code: string;
  readonly message: string;
  readonly phase: string;
  readonly retryable: boolean;
}

export interface DiagnosticSummary {
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
}

export interface CapabilityReport {
  readonly capabilityId: string;
  readonly capabilityConfigSchemaVersion: number;
  readonly outcome: FoundationOutcome;
  readonly summary: DiagnosticSummary;
  readonly diagnostics: readonly FoundationDiagnostic[];
  readonly problem?: FoundationProblem;
}

export interface FoundationCheckReport {
  readonly reportSchemaVersion: typeof FOUNDATION_REPORT_SCHEMA_VERSION;
  readonly foundationVersion: string;
  readonly coverage: "full";
  readonly outcome: FoundationOutcome;
  readonly summary: DiagnosticSummary;
  readonly capabilities: readonly CapabilityReport[];
  readonly problem?: FoundationProblem;
}
