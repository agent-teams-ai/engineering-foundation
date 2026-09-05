import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { installedFoundationVersion } from "../package-version.js";
import { FoundationTransactionCoordinator } from "../transaction-coordination/application/foundation-transaction-coordinator.js";
import { installedFoundationBuildIdentity } from "../transaction-coordination/adapters/node/installed-foundation-build-identity.js";
import { NodeFoundationOperationLock } from "../transaction-coordination/adapters/node/node-foundation-operation-lock.js";
import { createNodeFoundationTransactionSlot } from "./node-foundation-transaction-slot.js";

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
    slot: createNodeFoundationTransactionSlot({
      consumerRoot: canonicalRoot,
      installedVersion,
      installedBuildIdentity
    })
  });
}
