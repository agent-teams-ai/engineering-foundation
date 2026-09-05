import type { PortablePathIdentity } from "../../../path-identity.js";

export type DirectoryCreatePolicy = "allow" | "forbid";

export interface ProjectedDirectory {
  readonly absolutePath: string;
  readonly repositoryPath: string;
}

export interface CapturedDirectory extends ProjectedDirectory {
  readonly identity: PortablePathIdentity;
}

export interface DirectoryMaterializationProjection {
  readonly anchor: CapturedDirectory;
  readonly createPolicy: DirectoryCreatePolicy;
  readonly finalParent: ProjectedDirectory;
  readonly missingDirectories: readonly ProjectedDirectory[];
  readonly repositoryRoot: CapturedDirectory;
}

export interface BoundDirectoryCreation extends CapturedDirectory {
  readonly outcome: "created-and-bound";
  readonly parentIdentity: PortablePathIdentity;
}

export type UnboundDirectoryCreationRecovery =
  | { readonly outcome: "not-created" }
  | {
      readonly observedIdentity: PortablePathIdentity;
      readonly outcome: "ambiguous-manual";
    };

export type DirectoryMutationErrorCode =
  | "ALIAS_COLLISION"
  | "AMBIGUOUS_CREATION"
  | "CONCURRENT_CHANGE"
  | "CREATE_FORBIDDEN"
  | "IDENTITY_UNAVAILABLE"
  | "INVALID_PATH"
  | "NOT_DIRECTORY"
  | "OUTSIDE_ROOT"
  | "SYMLINK";

export class DirectoryMutationError extends Error {
  readonly code: DirectoryMutationErrorCode;
  readonly manualRecoveryRequired: boolean;

  constructor(
    code: DirectoryMutationErrorCode,
    message: string,
    options?: ErrorOptions & { readonly manualRecoveryRequired?: boolean }
  ) {
    super(message, options);
    this.name = "DirectoryMutationError";
    this.code = code;
    this.manualRecoveryRequired = options?.manualRecoveryRequired ?? false;
  }
}
