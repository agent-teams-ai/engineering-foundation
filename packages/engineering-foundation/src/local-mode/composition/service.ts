import { ensureFoundationStateDirectory, pruneFoundationStateDirectory, syncFoundationStateDirectory } from "../../transaction-coordination/adapters/node/node-foundation-state-directory.js";
import { LocalPackageLifecycle } from "../application/service.js";
import type { LocalPackageLifecyclePorts } from "../application/ports.js";
import type { AttachResult, FoundationDevOnlyStatus, FoundationStatus, ProcessRunner } from "../application/model.js";
import { inspectFoundationMode } from "./inspection.js";
import { inspectCanonicalConsumerDevOnly } from "../adapters/node/consumer-inspection.js";
import { createNodeLocalLinkStateStore } from "../adapters/node/local-state-store.js";
import { createNodeRegistryLinks } from "../adapters/node/registry-links.js";
import { createNodeLocalTargetReader } from "../adapters/node/target-reader.js";
import { createNodeFoundationTransactionCoordinator } from "../../transaction-coordination/adapters/node/node-foundation-transaction-coordinator.js";

export interface FoundationLocalModeServiceOptions {
  readonly runner: ProcessRunner;
  readonly now: () => Date;
}

export function createNodeLocalPackageLifecyclePorts(runner: ProcessRunner): LocalPackageLifecyclePorts {
  return {
    inspection: {
      mode: inspectFoundationMode,
      devOnly: inspectCanonicalConsumerDevOnly
    },
    target: createNodeLocalTargetReader(runner),
    state: createNodeLocalLinkStateStore({ ensure: ensureFoundationStateDirectory, prune: pruneFoundationStateDirectory, sync: syncFoundationStateDirectory }),
    links: createNodeRegistryLinks(runner, syncFoundationStateDirectory),
    coordinator: createNodeFoundationTransactionCoordinator
  };
}

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
