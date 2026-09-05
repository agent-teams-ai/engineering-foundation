import { NodeFoundationTransactionSlot } from "../transaction-coordination/adapters/node/node-foundation-transaction-slot.js";
import { inspectFoundationTransaction } from "./foundation-transaction-inspection.js";

export function createNodeFoundationTransactionSlot(options: {
  readonly consumerRoot: string;
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
}): NodeFoundationTransactionSlot {
  return new NodeFoundationTransactionSlot({
    consumerRoot: options.consumerRoot,
    inspection: { inspect: (value) => inspectFoundationTransaction(value, options) }
  });
}
