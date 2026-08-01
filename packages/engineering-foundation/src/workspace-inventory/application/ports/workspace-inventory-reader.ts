import type { WorkspaceInventory } from "../model/workspace-inventory.js";

export interface WorkspaceInventoryReader {
  read(
    consumerRoot: string,
    workspaceManifestPath: string,
    signal?: AbortSignal
  ): Promise<WorkspaceInventory>;
}
