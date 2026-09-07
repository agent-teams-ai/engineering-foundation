export type {
  AuthorityScaffoldRecoveryScope
} from "./application/model/recovery-scope.js";
export type {
  ConfiguredDefinition,
  DefinitionRef
} from "./application/model/scaffold-compilation.js";
export type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
  RepositoryPath,
  Sha256Digest
} from "./application/model/scaffold-values.js";
export type {
  MaterializeFileOperation,
  ScaffoldAppliedOperationReceipt,
  ScaffoldAuthorityEvidence,
  ScaffoldAuthorityReadSet,
  ScaffoldAuthoritySourceAssertion,
  ScaffoldAuthoritySourceRole,
  ScaffoldAuthorityVerifier,
  ScaffoldCompilationInput,
  ScaffoldComposition,
  ScaffoldDiagnostic,
  ScaffoldIntent,
  ScaffoldJournal,
  ScaffoldJournalOperation,
  ScaffoldJournalOperationState,
  ScaffoldOperationOutcome,
  ScaffoldOperationReceipt,
  ScaffoldOwnerDocumentBinding,
  ScaffoldPlan,
  ScaffoldReadAssertion,
  ScaffoldReceipt,
  ScaffoldReceiptCommon,
  ScaffoldReceiptOutcome,
  ScaffoldRecoveryScope,
  ScaffoldSatisfiedOperationReceipt,
  ScaffoldTarget,
  ScaffoldTargetCatalogEntry,
  ScaffoldTargetCatalog,
  ScaffoldingConfig
} from "./contract/scaffold-contract.js";
export {
  applyFilesystemScaffold,
  assertScaffoldAuthorityEvidenceDigest,
  assertScaffoldPlanDigest,
  assertScaffoldReceiptDigest,
  planScaffoldFromFile,
  readScaffoldPlanFile,
  recoverFilesystemScaffold,
  validateScaffoldReceipt
} from "../composition/scaffolding-api.js";
export { ScaffoldError } from "./scaffold-error.js";
export type { ScaffoldErrorCode } from "./scaffold-error.js";
export { DEFAULT_SCAFFOLDING_CONFIG_PATH } from "./scaffold-defaults.js";
