// Stable internal reporting protocol; no capability registry or adapter selection.
export type {
  RuleExplanation,
  CapabilityReport,
  DiagnosticEvidence,
  DiagnosticSeverity,
  DiagnosticSummary,
  FoundationCheckCoverage,
  FoundationCheckReport,
  FoundationDiagnostic,
  FoundationOutcome,
  FoundationProblem
} from "./application/model.js";
export { FOUNDATION_REPORT_SCHEMA_VERSION } from "./application/model.js";
export {
  CapabilityInputError,
  capabilityFailureReport,
  capabilityReport,
  exitCodeForOutcome,
  foundationReport,
  readCancellationProblem,
  readCapabilityInputProblem
} from "./application/reporting.js";
export type { CapabilityDefinition, CapabilityInvocation } from "./application/reporting.js";
export { classifyUnexpectedFailure, isProcessCancellationFailure } from "./application/unexpected-failure.js";
export type { UnexpectedFailureProblem } from "./application/unexpected-failure.js";
export { createUniqueRegistry } from "./application/unique-registry.js";
