import type { GrowthWorkspacePackage } from "../model/growth-workspace.js";

export interface GrowthWorkspaceReader {
  read(consumerRoot: string, workspaceManifestPath: string, signal?: AbortSignal): Promise<{ readonly packages: readonly GrowthWorkspacePackage[] }>;
}
