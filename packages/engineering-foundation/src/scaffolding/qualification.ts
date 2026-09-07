export { runScaffoldCrashQualification } from "../composition/scaffolding-qualification.js";
export type {
  ScaffoldQualificationPhase,
  ScaffoldQualificationPoint,
  ScaffoldQualificationPhaseCallback
} from "./testing/api.js";
// Canonical type closure of the qualification input and result.
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
  ScaffoldDiagnostic,
  ScaffoldIntent,
  ScaffoldOperationOutcome,
  ScaffoldOperationReceipt,
  ScaffoldOwnerDocumentBinding,
  ScaffoldPlan,
  ScaffoldReadAssertion,
  ScaffoldReceipt,
  ScaffoldReceiptCommon,
  ScaffoldSatisfiedOperationReceipt,
  ScaffoldTarget
} from "./contract/scaffold-contract.js";
