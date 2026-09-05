export { inspectFoundationPackage } from "./local-mode/adapters/node/package-inspection.js";
export {
  FOUNDATION_METADATA_SCHEMA_VERSION,
  parseFoundationPackageSelfCheck
} from "./local-mode/application/package-metadata.js";
export type { FoundationPackageSelfCheck } from "./local-mode/application/package-metadata.js";
export { FoundationError } from "./local-mode/application/errors/foundation-error.js";
export type { FoundationErrorCode } from "./local-mode/application/errors/foundation-error.js";
/** @deprecated Import `@agent-teams/engineering-foundation/local-mode` directly. */
export * as localMode from "./local-mode/index.js";
export { inspectFoundationTransactionAwareMode } from "./local-mode/composition/inspection.js";
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
} from "./capabilities/property-testing-standard/contract/deterministic-seed-bank.js";
export type {
  DeterministicSeedBank,
  FastCheckParameters,
  PropertyReplayEvidence
} from "./capabilities/property-testing-standard/contract/deterministic-seed-bank.js";
