import type {
  PublicApiArtifactSnapshot,
  PublicApiPackagePolicy
} from "../model/public-api.js";

export interface JsonSchemaSetInspection {
  readonly schemaSetDigest: `sha256:${string}`;
  readonly schemaIds: readonly string[];
}

export interface JsonSchemaSetInspector {
  inspect(input: {
    readonly consumerRoot: string;
    readonly schemaPaths: readonly string[];
    readonly fixtures: readonly never[];
    readonly requireMixedExpectations: false;
    readonly signal?: AbortSignal;
  }): Promise<JsonSchemaSetInspection>;
}

export interface PackageArtifactInventory {
  inspect(
    consumerRoot: string,
    policies: readonly PublicApiPackagePolicy[],
    signal?: AbortSignal
  ): Promise<readonly PublicApiArtifactSnapshot[]>;
}
