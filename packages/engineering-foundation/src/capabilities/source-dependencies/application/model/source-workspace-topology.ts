import type { SourceFileSnapshot } from "../../../../source-inventory/application/model/source-file-snapshot.js";
import type { WorkspaceInventory } from "../../../../workspace-inventory/application/model/workspace-inventory.js";

export interface SourceWorkspacePackageTopology {
  readonly name: string;
  readonly rootPath: string;
  readonly manifestPath: string;
  readonly sourcePaths: readonly string[];
}

export interface SourceWorkspaceTopology {
  readonly inventory: WorkspaceInventory;
  readonly packages: readonly SourceWorkspacePackageTopology[];
  /**
   * The stable snapshots for the exact, filtered topology paths that fall
   * beneath governed roots. Analysis must not independently rediscover them.
   */
  readonly sourceFiles: readonly SourceFileSnapshot[];
}
