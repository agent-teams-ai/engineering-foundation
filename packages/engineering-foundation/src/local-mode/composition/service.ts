import type { LocalPackageLifecyclePorts } from "../application/ports.js";
import type { ProcessRunner } from "../application/model.js";
import type { FoundationPackageSelfCheck } from "../application/package-metadata.js";
import { LocalPackageLifecycle } from "../api.js";
import type { LocalPackageLifecycleOptions } from "../application/service.js";
import {
  inspectCanonicalConsumerDevOnly,
  assertNodeLocalMutationSupported,
} from "../adapters/node/consumer-inspection.js";
import {
  createNodeLocalLinkStateStore,
  type LocalStateDirectory,
} from "../adapters/node/local-state-store.js";
import { createNodeRegistryLinks } from "../adapters/node/registry-links.js";
import { createNodeLocalTargetReader } from "../adapters/node/target-reader.js";

export interface NodeLocalPackageLifecycleDependencies {
  readonly runner: ProcessRunner;
  readonly mode: LocalPackageLifecyclePorts["inspection"]["mode"];
  readonly inspectPackage: (packageRoot: string) => Promise<FoundationPackageSelfCheck>;
  readonly stateDirectory: LocalStateDirectory;
  readonly coordinator: LocalPackageLifecyclePorts["coordinator"];
}

/** Concrete Node facade owns manager admission before lifecycle inspection. */
export class NodeLocalPackageLifecycle {
  readonly #lifecycle: LocalPackageLifecycle;

  constructor(options: LocalPackageLifecycleOptions) {
    this.#lifecycle = new LocalPackageLifecycle(options);
  }

  status(path: string) {
    return this.#lifecycle.status(path);
  }

  async attach(path: string, target: string) {
    await assertNodeLocalMutationSupported(path);
    return this.#lifecycle.attach(path, target);
  }

  async detach(path: string) {
    await assertNodeLocalMutationSupported(path);
    return this.#lifecycle.detach(path);
  }

  assertRegistry(path: string) {
    return this.#lifecycle.assertRegistry(path);
  }

  assertDevOnly(path: string) {
    return this.#lifecycle.assertDevOnly(path);
  }
}

async function guarded<T>(root: string, effect: () => Promise<T>): Promise<T> {
  await assertNodeLocalMutationSupported(root);
  return effect();
}

export function createNodeLocalPackageLifecyclePorts(
  dependencies: NodeLocalPackageLifecycleDependencies,
): LocalPackageLifecyclePorts {
  const target = createNodeLocalTargetReader(dependencies.runner, dependencies.inspectPackage);
  const state = createNodeLocalLinkStateStore(dependencies.stateDirectory);
  const links = createNodeRegistryLinks(dependencies.runner, (path) =>
    dependencies.stateDirectory.sync(path),
  );
  return {
    inspection: {
      mode: async (path, options) => {
        if (options?.ignoreOperationLock === true) {
          await assertNodeLocalMutationSupported(path);
        }
        const status = await dependencies.mode(path, options);
        if (options?.ignoreOperationLock === true) {
          await assertNodeLocalMutationSupported(path);
        }
        return status;
      },
      devOnly: inspectCanonicalConsumerDevOnly,
    },
    target: {
      verify: (root, path) => guarded(root, () => target.verify(root, path)),
      git: (root, path) => guarded(root, () => target.git(root, path)),
    },
    state: {
      write: (root, value) => guarded(root, () => state.write(root, value)),
      remove: state.remove,
    },
    links: {
      prepare: (root, path) => guarded(root, () => links.prepare(root, path)),
      ignoreLocalState: (root) => guarded(root, () => links.ignoreLocalState(root)),
      replace: (value) => guarded(value.consumerRoot, () => links.replace(value)),
      restore: (root, spec, value) => links.restore(root, spec, value),
    },
    coordinator: async (path) => {
      await assertNodeLocalMutationSupported(path);
      const coordinator = await dependencies.coordinator(path);
      return {
        acquire: (options) => guarded(path, () => coordinator.acquire(options)),
        inspect: () => coordinator.inspect(),
      };
    },
  };
}
