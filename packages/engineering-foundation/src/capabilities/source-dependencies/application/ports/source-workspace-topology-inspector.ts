import type { SourceWorkspaceTopology } from "../model/source-workspace-topology.js";
import type { WorkspaceInventory } from "../../../../workspace-inventory/application/model/workspace-inventory.js";

export interface SourceBoundaryRootDescription {
  readonly boundaryId: string;
  readonly path: string;
}

export interface InspectSourceWorkspaceTopologyInput {
  readonly consumerRoot: string;
  readonly workspaceManifestPath: string;
  readonly packageRoots: readonly string[];
  readonly governedRoots: readonly string[];
  readonly boundaryRoots: readonly SourceBoundaryRootDescription[];
  readonly signal?: AbortSignal;
}

/**
 * Builds the workspace inventory from the already-read pnpm workspace
 * snapshot and the exact, contained manifest paths selected by topology
 * discovery. Keeping this operation separate prevents a second manifest read.
 */
export interface SourceWorkspaceInventorySnapshotReader {
  discoverManifestPathsFromManifest(
    consumerRoot: string,
    workspaceManifest: unknown,
    signal?: AbortSignal
  ): Promise<readonly string[]>;

  readFromManifestPaths(
    consumerRoot: string,
    workspaceManifest: unknown,
    manifestPaths: readonly string[],
    signal?: AbortSignal
  ): Promise<WorkspaceInventory>;
}

export interface SourceWorkspaceTopologyInspector {
  inspect(
    input: InspectSourceWorkspaceTopologyInput
  ): Promise<SourceWorkspaceTopology>;
}
