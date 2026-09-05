export { inspectFoundationDevOnly, inspectFoundationRegistryProvenance } from "./adapters/node/consumer-inspection.js";
export { isExactVersion } from "../semantic-version.js";
export {
  inspectFoundationMode
} from "../composition/local-mode-inspection.js";
/**
 * @deprecated Qualification-only concrete adapter. Import from
 * `@agent-teams/repository-mutation/qualification` and keep
 * production integrations on the ProcessRunner port.
 */
export { NodeProcessRunner } from "./composition/process-runner.js";
export { FoundationLocalModeService } from "../composition/local-mode-service.js";
export type { FoundationLocalModeServiceOptions } from "../composition/local-mode-service.js";
export {
  FOUNDATION_PACKAGE_NAME,
  FOUNDATION_LOCAL_MODE_PROTOCOL_VERSION,
  LOCAL_OPERATION_LOCK,
  LOCAL_REGISTRY_BACKUP,
  LOCAL_STATE_DIRECTORY,
  LOCAL_STATE_FILE
} from "./application/model.js";
export type {
  AttachResult,
  ConsumerPolicyInspection,
  FoundationDevOnlyStatus,
  FoundationLinkPhase,
  FoundationLinkState,
  FoundationMode,
  FoundationRegistryProvenance,
  FoundationStatus,
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
  RegistryProvenanceInspection
} from "./application/model.js";
