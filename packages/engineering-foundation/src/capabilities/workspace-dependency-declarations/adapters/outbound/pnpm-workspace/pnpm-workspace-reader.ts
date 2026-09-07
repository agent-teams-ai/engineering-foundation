import type { WorkspaceSnapshot } from "../../../application/model/workspace-snapshot.js";
import type { WorkspaceReader } from "../../../application/ports/workspace-reader.js";

export class PnpmWorkspaceReader implements WorkspaceReader {
  constructor(private readonly inventoryReader: WorkspaceReader) {}

  read(
    consumerRoot: string,
    workspaceManifestPath: string,
    signal?: AbortSignal
  ): Promise<WorkspaceSnapshot> {
    return this.inventoryReader.read(
      consumerRoot,
      workspaceManifestPath,
      signal
    );
  }
}
