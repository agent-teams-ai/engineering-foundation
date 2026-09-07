import { NodeFoundationOperationLock } from "../../transaction-coordination/adapters/node/node-foundation-operation-lock.js";

export async function acquireFoundationOperationLock(consumerRoot: string): Promise<() => Promise<void>> {
  return new NodeFoundationOperationLock(consumerRoot).acquire();
}
