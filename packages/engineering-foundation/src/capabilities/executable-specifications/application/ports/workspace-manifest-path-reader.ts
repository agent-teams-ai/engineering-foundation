export interface WorkspaceManifestPathReader {
  discoverManifestPaths(
    consumerRoot: string,
    workspaceManifestPath: string,
    signal?: AbortSignal
  ): Promise<readonly string[]>;
}
