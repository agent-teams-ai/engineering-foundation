export const FOUNDATION_PACKAGE_NAME =
  "@agent-teams/engineering-foundation" as const;
export {
  LOCAL_OPERATION_LOCK,
  LOCAL_STATE_DIRECTORY
} from "../transaction-coordination/adapters/node/foundation-state-paths.js";
export const LOCAL_STATE_FILE = "foundation-link.json" as const;
export const LOCAL_REGISTRY_BACKUP = "foundation-registry-backup" as const;
export const FOUNDATION_LOCAL_MODE_PROTOCOL_VERSION = 1 as const;

export type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner
} from "../process-execution/types.js";

export type FoundationMode = "INVALID" | "LOCAL" | "REGISTRY";
export type FoundationLinkPhase = "ATTACHING" | "DETACHING" | "LOCAL";

export interface FoundationLinkState {
  readonly schemaVersion: 1;
  readonly phase: FoundationLinkPhase;
  readonly consumerRoot: string;
  readonly targetPackageRoot: string;
  readonly registryBackupPath: string;
  readonly registryEntryKind: "directory" | "symbolic-link";
  readonly registryPackageRoot: string;
  readonly packageVersion: string;
  readonly gitCommit: string;
  readonly gitDirty: boolean;
  readonly attachedAt: string;
}

export interface FoundationStatus {
  readonly mode: FoundationMode;
  readonly consumerRoot: string;
  readonly dependencySpec?: string;
  readonly installedPackageRoot?: string;
  readonly installedVersion?: string;
  readonly lockfilePath?: string;
  readonly lockfilePackageKey?: string;
  readonly registryIntegrity?: string;
  readonly linkState?: FoundationLinkState;
  readonly sourceGitCommit?: string;
  readonly sourceGitDirty?: boolean;
  readonly issues: readonly string[];
}

export interface FoundationDevOnlyStatus {
  readonly consumerRoot: string;
  readonly dependencySpec?: string;
  readonly issues: readonly string[];
}

/** Public result of inspecting the consumer dependency policy. */
export interface ConsumerPolicyInspection extends FoundationDevOnlyStatus {
  readonly packageManager?: string;
}

/** Public result of inspecting the installed registry provenance. */
export interface RegistryProvenanceInspection {
  readonly provenance?: FoundationRegistryProvenance;
  readonly issues: readonly string[];
}

export interface FoundationRegistryProvenance {
  readonly lockfilePath: string;
  readonly packageKey: string;
  readonly integrity: string;
}

export interface AttachResult {
  readonly status: FoundationStatus;
  readonly targetPackageRoot: string;
}
