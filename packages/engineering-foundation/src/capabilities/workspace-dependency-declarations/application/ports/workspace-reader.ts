import type { WorkspaceSnapshot } from "../model/workspace-snapshot.js";

export interface WorkspaceReader {
  read(
    consumerRoot: string,
    workspaceManifestPath: string,
    signal?: AbortSignal
  ): Promise<WorkspaceSnapshot>;
}
