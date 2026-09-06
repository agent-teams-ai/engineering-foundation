// Stable internal reporting protocol and metadata integrity; no adapter selection.
export type {
  RuleExplanation,
  DiagnosticEvidence,
  DiagnosticSeverity,
  FoundationCheckCoverage,
  FoundationCheckReport,
  FoundationDiagnostic,
  FoundationOutcome,
  FoundationProblem
} from "./application/model.js";
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
export { classifyUnexpectedFailure } from "./application/unexpected-failure.js";
export { createUniqueRegistry } from "./application/unique-registry.js";
export {
  createCapabilityModule,
  createCapabilityModules,
  createCapabilityRegistry,
  createRuleRegistries,
  createRuleRegistry
} from "./application/capability-registries.js";
export type { CapabilityModuleDescriptor } from "./application/capability-registries.js";
export { FoundationError } from "./foundation-error.js";
export type { FoundationErrorCode } from "./foundation-error.js";
export { assertNotCancelled } from "./application/cancellation.js";
