import type { LocalPackageLifecyclePorts } from "../application/ports.js";
import type { ProcessRunner } from "../application/model.js";
import type { FoundationPackageSelfCheck } from "../application/package-metadata.js";
import { inspectCanonicalConsumerDevOnly } from "../adapters/node/consumer-inspection.js";
import { createNodeLocalLinkStateStore, type LocalStateDirectory } from "../adapters/node/local-state-store.js";
import { createNodeRegistryLinks } from "../adapters/node/registry-links.js";
import { createNodeLocalTargetReader } from "../adapters/node/target-reader.js";

export interface NodeLocalPackageLifecycleDependencies {
  readonly runner: ProcessRunner;
  readonly mode: LocalPackageLifecyclePorts["inspection"]["mode"];
  readonly inspectPackage: (packageRoot: string) => Promise<FoundationPackageSelfCheck>;
  readonly stateDirectory: LocalStateDirectory;
  readonly coordinator: LocalPackageLifecyclePorts["coordinator"];
}

export function createNodeLocalPackageLifecyclePorts(dependencies: NodeLocalPackageLifecycleDependencies): LocalPackageLifecyclePorts {
  return {
    inspection: { mode: dependencies.mode, devOnly: inspectCanonicalConsumerDevOnly },
    target: createNodeLocalTargetReader(dependencies.runner, dependencies.inspectPackage),
    state: createNodeLocalLinkStateStore(dependencies.stateDirectory),
    links: createNodeRegistryLinks(dependencies.runner, (path) => dependencies.stateDirectory.sync(path)),
    coordinator: dependencies.coordinator
  };
}
