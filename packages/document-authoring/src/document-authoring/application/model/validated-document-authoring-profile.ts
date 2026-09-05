import type { DocumentArtifactType, DocumentCatalogCollection, DocumentReachabilityStrategy } from "./document-planning.js";

export interface ValidatedDocumentAuthoringProfile {
  readonly authoring: {
    readonly artifactTypes: readonly (
      Omit<DocumentArtifactType, "reachability"> & {
        readonly reachability?: DocumentReachabilityStrategy;
      }
    )[];
    readonly mode: "create-only";
  };
  readonly catalog: {
    readonly collections: readonly DocumentCatalogCollection[];
    readonly excludedPrefixes?: readonly string[];
    readonly metadataSchemaPath: string;
    readonly ownerCatalog: {
      readonly contract: "foundation.owner-map/v1";
      readonly path: string;
    };
  };
  readonly projectId: string;
  readonly schemaVersion: 1;
}

export class InvalidDocumentAuthoringProfileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidDocumentAuthoringProfileError";
  }
}

export interface ValidatedDocumentAuthoringProfileV2
  extends Omit<
    ValidatedDocumentAuthoringProfile,
    "authoring" | "catalog" | "schemaVersion"
  > {
  readonly authoring: {
    readonly artifactTypes: readonly (
      ValidatedDocumentAuthoringProfile["authoring"]["artifactTypes"][number] & {
        readonly allowedOwnerIds: readonly string[];
      }
    )[];
    readonly mode: "create-only";
  };
  readonly catalog: ValidatedDocumentAuthoringProfile["catalog"] & {
    readonly metadataSidecar?: {
      readonly kind: "path-metadata-map";
      readonly path: string;
    };
  };
  readonly schemaVersion: 2;
}

export interface ValidatedDocumentAuthoringProfileV3
  extends Omit<
    ValidatedDocumentAuthoringProfile,
    "authoring" | "catalog" | "schemaVersion"
  > {
  readonly authoring: {
    readonly artifactTypes: readonly (
      ValidatedDocumentAuthoringProfile["authoring"]["artifactTypes"][number] & (
        | {
            readonly allowedOwnerIds: readonly string[];
            readonly ownerSetId?: never;
          }
        | {
            readonly allowedOwnerIds?: never;
            readonly ownerSetId: string;
          }
      )
    )[];
    readonly mode: "create-only";
    readonly ownerSets?: {
      readonly schemaVersion: 1;
      readonly sets: Readonly<Record<string, readonly string[]>>;
    };
  };
  readonly catalog: ValidatedDocumentAuthoringProfile["catalog"] & {
    readonly metadataSidecar?: {
      readonly kind: "path-metadata-map";
      readonly path: string;
    };
  };
  readonly schemaVersion: 3;
}

export type ValidatedDocumentAuthoringProfileVersioned =
  | ValidatedDocumentAuthoringProfile
  | ValidatedDocumentAuthoringProfileV2
  | ValidatedDocumentAuthoringProfileV3;

export function resolvedArtifactOwnerIds(
  profile: ValidatedDocumentAuthoringProfileVersioned,
  artifactType: ValidatedDocumentAuthoringProfileVersioned["authoring"]["artifactTypes"][number]
): readonly string[] | undefined {
  if (profile.schemaVersion === 1) {
    return undefined;
  }
  if (profile.schemaVersion === 2) {
    const artifact = profile.authoring.artifactTypes.find(
      (candidate) => candidate.type === artifactType.type
    );
    if (artifact === undefined) {
      throw new TypeError(`Profile v2 artifact type ${artifactType.type} must declare allowedOwnerIds.`);
    }
    return Object.freeze([...artifact.allowedOwnerIds]);
  }
  const artifact = profile.authoring.artifactTypes.find(
    (candidate) => candidate.type === artifactType.type
  );
  if (artifact?.allowedOwnerIds !== undefined) {
    return Object.freeze([...artifact.allowedOwnerIds]);
  }
  const ids = artifact === undefined
    ? undefined
    : profile.authoring.ownerSets?.sets[artifact.ownerSetId];
  if (ids === undefined) {
    throw new TypeError(`Profile v3 artifact type ${artifactType.type} references an unknown ownerSetId.`);
  }
  return Object.freeze([...ids]);
}

export function resolvedProfileMetadataSidecar(
  profile: ValidatedDocumentAuthoringProfileVersioned
): ValidatedDocumentAuthoringProfileV2["catalog"]["metadataSidecar"] {
  return profile.schemaVersion === 1
    ? undefined
    : profile.catalog.metadataSidecar;
}

