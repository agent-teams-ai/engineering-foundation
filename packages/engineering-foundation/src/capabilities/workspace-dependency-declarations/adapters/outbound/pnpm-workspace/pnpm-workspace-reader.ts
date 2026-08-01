import { PnpmWorkspaceInventoryReader } from "../../../../../workspace-inventory/adapters/outbound/pnpm/pnpm-workspace-inventory-reader.js";
import type { WorkspaceSnapshot } from "../../../application/model/workspace-snapshot.js";
import type { WorkspaceReader } from "../../../application/ports/workspace-reader.js";

export class PnpmWorkspaceReader implements WorkspaceReader {
  readonly #inventoryReader = new PnpmWorkspaceInventoryReader();

  read(
    consumerRoot: string,
    workspaceManifestPath: string,
    signal?: AbortSignal
  ): Promise<WorkspaceSnapshot> {
    return this.#inventoryReader.read(
      consumerRoot,
      workspaceManifestPath,
      signal
    );
  }
}
