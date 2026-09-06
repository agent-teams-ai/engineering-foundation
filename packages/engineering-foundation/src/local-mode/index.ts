import { LocalPackageLifecycle } from "./api.js";
import type { AttachResult, FoundationDevOnlyStatus, FoundationStatus, FoundationLocalModeServiceOptions } from "./api.js";
import { createNodeLocalPackageLifecyclePorts } from "../composition/local-mode-ports.js";

export { inspectFoundationDevOnly, inspectFoundationRegistryProvenance } from "./adapters/node/consumer-inspection.js";
export { isExactVersion } from "./api.js";
export {
  inspectFoundationMode
} from "../composition/local-mode-inspection.js";
/**
 * @deprecated Qualification-only concrete adapter. Import from
 * `@agent-teams/repository-mutation/qualification` and keep
 * production integrations on the ProcessRunner port.
 */
export { NodeProcessRunner } from "./composition/process-runner.js";

export type { FoundationLocalModeServiceOptions } from "./application/ports.js";
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

/** Supported public constructor; concrete dependencies are selected only here. */
export class FoundationLocalModeService {
  readonly #lifecycle: LocalPackageLifecycle;

  constructor(options: FoundationLocalModeServiceOptions) {
    this.#lifecycle = new LocalPackageLifecycle({ ports: createNodeLocalPackageLifecyclePorts(options.runner), now: options.now });
  }

  async status(consumerPath: string): Promise<FoundationStatus> {
    return this.#lifecycle.status(consumerPath);
  }
  async attach(consumerPath: string, targetPath: string): Promise<AttachResult> {
    return this.#lifecycle.attach(consumerPath, targetPath);
  }
  async detach(consumerPath: string): Promise<FoundationStatus> {
    return this.#lifecycle.detach(consumerPath);
  }
  async assertRegistry(consumerPath: string): Promise<FoundationStatus> {
    return this.#lifecycle.assertRegistry(consumerPath);
  }
  async assertDevOnly(consumerPath: string): Promise<FoundationDevOnlyStatus> {
    return this.#lifecycle.assertDevOnly(consumerPath);
  }
}
