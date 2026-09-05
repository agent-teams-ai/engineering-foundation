import { installedFoundationVersion } from "./installed-foundation-version.js";
import { installedFoundationBuildIdentity } from "./installed-foundation-build-identity.js";
import { NodeFoundationTransactionSlot } from "./node-foundation-transaction-slot.js";
import type { FoundationTransactionInspection, InstalledFoundationInspectionIdentity } from "../../application/ports/foundation-transaction-inspection.js";
import type { InternalFoundationTransactionStatus } from "../../application/model/internal-transaction-status.js";

export async function inspectInstalledFoundationTransaction(
  consumerRoot: string,
  createInspection: (installed: InstalledFoundationInspectionIdentity) => FoundationTransactionInspection
): Promise<InternalFoundationTransactionStatus> {
  const installedVersion = await installedFoundationVersion();
  const installedBuildIdentity = await installedFoundationBuildIdentity();
  return new NodeFoundationTransactionSlot({
    consumerRoot,
    inspection: createInspection({ installedVersion, installedBuildIdentity })
  }).inspect();
}
