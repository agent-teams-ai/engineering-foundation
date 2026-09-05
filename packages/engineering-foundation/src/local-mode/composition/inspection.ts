import { createNodeModeInspector } from "../adapters/node/mode-inspection.js";
import { installedFoundationVersion } from "../../transaction-coordination/adapters/node/installed-foundation-version.js";
import { installedFoundationBuildIdentity } from "../../transaction-coordination/adapters/node/installed-foundation-build-identity.js";
import { createNodeFoundationTransactionSlot } from "../../composition/node-foundation-transaction-slot.js";
import type { FoundationStatus, FoundationTransactionAwareStatus } from "../application/model.js";

const inspectMode = createNodeModeInspector(async (consumerRoot) => createNodeFoundationTransactionSlot({
  consumerRoot,
  installedVersion: await installedFoundationVersion(),
  installedBuildIdentity: await installedFoundationBuildIdentity()
}).inspect());

export async function inspectFoundationMode(consumerPath: string, options: { readonly ignoreOperationLock?: boolean } = {}): Promise<FoundationStatus> {
  return inspectMode(consumerPath, options);
}

export async function inspectFoundationTransactionAwareMode(consumerPath: string, options: { readonly ignoreOperationLock?: boolean } = {}): Promise<FoundationTransactionAwareStatus> {
  return inspectMode(consumerPath, options);
}
