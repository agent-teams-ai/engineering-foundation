import { createFoundationTransactionCoordinatorFactory } from "../transaction-coordination/composition/node-coordinator.js";
import type { FoundationTransactionCoordinator } from "../transaction-coordination/application/foundation-transaction-coordinator.js";
import { createNodeFoundationTransactionSlot } from "./node-foundation-transaction-slot.js";

const coordinator = createFoundationTransactionCoordinatorFactory(createNodeFoundationTransactionSlot);

export async function createNodeFoundationTransactionCoordinator(
  consumerRoot: string
): Promise<FoundationTransactionCoordinator> {
  return coordinator.createNodeFoundationTransactionCoordinator(consumerRoot);
}
