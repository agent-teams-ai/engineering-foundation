import { createNodeLocalPackageLifecyclePorts as createPorts } from "../local-mode/node.js";
import type { LocalPackageLifecyclePorts, ProcessRunner } from "../local-mode/api.js";
import { ensureFoundationStateDirectory, pruneFoundationStateDirectory, syncFoundationStateDirectory } from "../transaction-coordination/node.js";
import { inspectFoundationMode } from "./local-mode-inspection.js";
import { inspectFoundationPackage } from "./local-package-inspection.js";
import { createNodeFoundationTransactionCoordinator } from "./node-foundation-transaction-coordinator.js";

export function createNodeLocalPackageLifecyclePorts(runner: ProcessRunner): LocalPackageLifecyclePorts {
  return createPorts({
    runner,
    mode: inspectFoundationMode,
    inspectPackage: inspectFoundationPackage,
    stateDirectory: { ensure: ensureFoundationStateDirectory, prune: pruneFoundationStateDirectory, sync: syncFoundationStateDirectory },
    coordinator: createNodeFoundationTransactionCoordinator
  });
}
