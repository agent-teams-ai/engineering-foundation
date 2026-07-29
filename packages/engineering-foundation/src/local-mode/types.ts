export const FOUNDATION_PACKAGE_NAME =
  "@agent-teams/engineering-foundation" as const;
export const LOCAL_STATE_DIRECTORY = ".agent-teams-local" as const;
export const LOCAL_STATE_FILE = "foundation-link.json" as const;
export const LOCAL_REGISTRY_BACKUP = "foundation-registry-backup" as const;
export const LOCAL_OPERATION_LOCK = "foundation-operation.lock" as const;

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
  readonly linkState?: FoundationLinkState;
  readonly sourceGitCommit?: string;
  readonly sourceGitDirty?: boolean;
  readonly issues: readonly string[];
}

export interface AttachResult {
  readonly status: FoundationStatus;
  readonly targetPackageRoot: string;
}

export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}
