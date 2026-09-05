import type { FoundationTransactionCoordinator } from "../../transaction-coordination/application/foundation-transaction-coordinator.js";
import type { FoundationDevOnlyStatus, FoundationLinkState, FoundationStatus } from "./model.js";

export interface LocalModeInspector {
  mode(consumerPath: string, options?: { readonly ignoreOperationLock?: boolean }): Promise<FoundationStatus>;
  devOnly(consumerPath: string): Promise<FoundationDevOnlyStatus>;
}

export interface LocalTargetReader {
  verify(consumerRoot: string, targetPath: string): Promise<{
    readonly targetPackageRoot: string;
    readonly packageVersion: string;
  }>;
  git(consumerRoot: string, targetPackageRoot: string): Promise<{
    readonly gitCommit: string;
    readonly gitDirty: boolean;
  }>;
}

/** Owns durable local-link evidence; callers decide lifecycle transitions. */
export interface LocalLinkStateStore {
  write(consumerRoot: string, state: FoundationLinkState): Promise<void>;
  remove(consumerRoot: string): Promise<void>;
}

/** Physical entry validation and mutation, with no package-manager installation. */
export interface RegistryLinks {
  prepare(consumerRoot: string, registryPackageRoot: string): Promise<{
    readonly registryBackupPath: string;
    readonly registryEntryKind: FoundationLinkState["registryEntryKind"];
  }>;
  ignoreLocalState(consumerRoot: string): Promise<void>;
  replace(state: FoundationLinkState): Promise<void>;
  restore(consumerRoot: string, dependencySpec: string, state: FoundationLinkState | undefined): Promise<void>;
}

export interface LocalPackageLifecyclePorts {
  readonly inspection: LocalModeInspector;
  readonly target: LocalTargetReader;
  readonly state: LocalLinkStateStore;
  readonly links: RegistryLinks;
  readonly coordinator: (consumerPath: string) => Promise<Pick<FoundationTransactionCoordinator, "acquire" | "inspect">>;
}
