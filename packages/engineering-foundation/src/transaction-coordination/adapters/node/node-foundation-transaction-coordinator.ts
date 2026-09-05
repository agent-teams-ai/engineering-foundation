import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { installedFoundationVersion } from "./installed-foundation-version.js";
import { FoundationTransactionCoordinator } from "../../application/foundation-transaction-coordinator.js";
import { installedFoundationBuildIdentity } from "./installed-foundation-build-identity.js";
import { NodeFoundationOperationLock } from "./node-foundation-operation-lock.js";
import { NodeFoundationTransactionSlot } from "./node-foundation-transaction-slot.js";

export async function createNodeFoundationTransactionCoordinator(
  consumerRoot: string
): Promise<FoundationTransactionCoordinator> {
  const canonicalRoot = await realpath(resolve(consumerRoot));
  const [installedVersion, installedBuildIdentity] = await Promise.all([
    installedFoundationVersion(),
    installedFoundationBuildIdentity()
  ]);
  return new FoundationTransactionCoordinator({
    lock: new NodeFoundationOperationLock(canonicalRoot),
    slot: new NodeFoundationTransactionSlot({
      consumerRoot: canonicalRoot,
      installedVersion,
      installedBuildIdentity
    })
  });
}
