export { inspectFoundationPackage } from "./composition/local-package-inspection.js";
export {
  FOUNDATION_METADATA_SCHEMA_VERSION,
  parseFoundationPackageSelfCheck
} from "./local-mode/application/package-metadata.js";
export type { FoundationPackageSelfCheck } from "./local-mode/application/package-metadata.js";
export { FoundationError } from "./features/validation-reporting/api.js";
export type { FoundationErrorCode } from "./features/validation-reporting/api.js";
/** @deprecated Import `@agent-teams/engineering-foundation/local-mode` directly. */
export * as localMode from "./local-mode/index.js";
export { inspectFoundationTransactionAwareMode } from "./composition/local-mode-inspection.js";
export type {
  FoundationManualRecoveryReason,
  FoundationRecoveryRoute,
  FoundationTransactionAwareStatus,
  FoundationTransactionDiagnostic,
  FoundationTransactionStatus
} from "./local-mode/application/model.js";
export {
  createFastCheckParameters,
  normalizeDeterministicSeedBank,
  normalizePropertyReplayEvidence,
  PropertyTestingEvidenceError
} from "./capabilities/property-testing-standard/api.js";
export type {
  DeterministicSeedBank,
  FastCheckParameters,
  PropertyReplayEvidence
} from "./capabilities/property-testing-standard/api.js";
