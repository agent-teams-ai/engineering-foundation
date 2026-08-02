export type {
  ConfiguredDefinition,
  DefinitionRef,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  MaterializeFileOperationV1,
  RepositoryPath,
  ScaffoldCompositionV1,
  ScaffoldDiagnosticV1,
  ScaffoldIntentV1,
  ScaffoldOperationOutcome,
  ScaffoldOperationReceiptV1,
  ScaffoldPlanV1,
  ScaffoldReadAssertionV1,
  ScaffoldReceiptCommonV1,
  ScaffoldReceiptOutcome,
  ScaffoldReceiptV1,
  ScaffoldingConfigV1,
  ScaffoldTargetCatalogV1,
  ScaffoldTargetV1,
  Sha256Digest
} from "./contract/types.js";
export {
  applyFilesystemScaffold,
  recoverFilesystemScaffold
} from "./adapters/node/filesystem-workspace.js";
export { readScaffoldPlanFile } from "./adapters/node/node-input-loader.js";
export { MemoryScaffoldWorkspace } from "./adapters/memory/memory-workspace.js";
export { assertScaffoldPlanDigest } from "./kernel/plan-validation.js";
export { assertScaffoldReceiptDigest } from "./kernel/receipt.js";
export { ScaffoldError } from "./scaffold-error.js";
export type { ScaffoldErrorCode } from "./scaffold-error.js";
export {
  DEFAULT_SCAFFOLDING_CONFIG_PATH,
  planScaffoldFromFile
} from "./service.js";
