import type { CatalogEntry, WorkspacePackage } from "../model/workspace-inventory.js";

export interface WorkspaceManifestFileObservation {
  readonly read: (input: {
    readonly candidate: string;
    readonly maxBytes: number;
    readonly root: string;
  }) => Promise<Uint8Array>;
  readonly pathTraversesSymbolicLink: (root: string, candidate: string) => Promise<boolean>;
}

export interface WorkspaceYamlObservation {
  readonly readYaml: (
    consumerRoot: string,
    repositoryPath: string,
    phase: string,
    signal?: AbortSignal
  ) => Promise<unknown>;
}

export interface PackageManifestSnapshotReader {
  readonly read: (
    consumerRoot: string,
    paths: readonly string[],
    catalogs: readonly CatalogEntry[],
    signal?: AbortSignal
  ) => Promise<readonly WorkspacePackage[]>;
}
