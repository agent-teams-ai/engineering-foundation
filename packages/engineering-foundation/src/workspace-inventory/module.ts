import { PnpmWorkspaceInventoryReader } from "./adapters/outbound/pnpm/pnpm-workspace-inventory-reader.js";

import type { WorkspaceObservationReader } from "./api.js";

export function createWorkspaceInventoryReader(): WorkspaceObservationReader {
  return new PnpmWorkspaceInventoryReader();
}
