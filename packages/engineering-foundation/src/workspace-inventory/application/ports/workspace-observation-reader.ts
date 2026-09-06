import type { WorkspaceInventory } from "../model/workspace-inventory.js";
import type { WorkspaceInventoryReader } from "./workspace-inventory-reader.js";

export interface WorkspaceObservationReader extends WorkspaceInventoryReader {
  discoverManifestPaths(consumerRoot: string, workspaceManifestPath: string, signal?: AbortSignal): Promise<readonly string[]>;
  discoverManifestPathsFromManifest(consumerRoot: string, workspaceManifest: unknown, signal?: AbortSignal): Promise<readonly string[]>;
  readFromManifestPaths(consumerRoot: string, workspaceManifest: unknown, manifestPaths: readonly string[], signal?: AbortSignal): Promise<WorkspaceInventory>;
}
