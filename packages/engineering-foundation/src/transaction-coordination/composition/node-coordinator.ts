import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { installedFoundationVersion } from "../adapters/node/installed-foundation-version.js";
import { FoundationTransactionCoordinator } from "../application/foundation-transaction-coordinator.js";
import { installedFoundationBuildIdentity } from "../adapters/node/installed-foundation-build-identity.js";
import { NodeFoundationOperationLock } from "../adapters/node/node-foundation-operation-lock.js";
import type { FoundationTransactionSlotFactory } from "../application/ports/foundation-transaction-slot-factory.js";

export function createFoundationTransactionCoordinatorFactory(createNodeFoundationTransactionSlot: FoundationTransactionSlotFactory) {
  return { async createNodeFoundationTransactionCoordinator(
    consumerRoot: string
  ): Promise<FoundationTransactionCoordinator> {
    const canonicalRoot = await realpath(resolve(consumerRoot));
    const [installedVersion, installedBuildIdentity] = await Promise.all([
      installedFoundationVersion(),
      installedFoundationBuildIdentity()
    ]);
    return new FoundationTransactionCoordinator({
      lock: new NodeFoundationOperationLock(canonicalRoot),
      slot: createNodeFoundationTransactionSlot({
        consumerRoot: canonicalRoot,
        installedVersion,
        installedBuildIdentity
      })
    });
  } };
}
