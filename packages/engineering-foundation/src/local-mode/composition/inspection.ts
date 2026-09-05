import { createNodeModeInspector } from "../adapters/node/mode-inspection.js";
import { installedFoundationVersion } from "../adapters/node/installed-package-version.js";
import { installedFoundationBuildIdentity } from "../../transaction-coordination/adapters/node/installed-foundation-build-identity.js";
import { NodeFoundationTransactionSlot } from "../../transaction-coordination/adapters/node/node-foundation-transaction-slot.js";
import type { FoundationStatus, FoundationTransactionAwareStatus } from "../application/model.js";

const inspectMode = createNodeModeInspector(async (consumerRoot) => new NodeFoundationTransactionSlot({
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
