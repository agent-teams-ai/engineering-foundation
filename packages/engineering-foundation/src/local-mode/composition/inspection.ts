import { createNodeModeInspector } from "../adapters/node/mode-inspection.js";
import type { InternalFoundationTransactionStatus } from "../../transaction-coordination/application/model/internal-transaction-status.js";
import type { FoundationStatus, FoundationTransactionAwareStatus } from "../application/model.js";

export function createFoundationModeInspection(readTransaction: (consumerRoot: string) => Promise<InternalFoundationTransactionStatus>) {
  const inspectMode = createNodeModeInspector(readTransaction);
  return {
    async inspectFoundationMode(consumerPath: string, options: { readonly ignoreOperationLock?: boolean } = {}): Promise<FoundationStatus> {
      return inspectMode(consumerPath, options);
    },
    async inspectFoundationTransactionAwareMode(consumerPath: string, options: { readonly ignoreOperationLock?: boolean } = {}): Promise<FoundationTransactionAwareStatus> {
      return inspectMode(consumerPath, options);
    }
  };
}
