import { createNodeModeInspector } from "../adapters/node/mode-inspection.js";
import type { LocalModeTransactionReader } from "../application/ports.js";
import type { FoundationStatus, FoundationTransactionAwareStatus } from "../application/model.js";

export function createFoundationModeInspection(readTransaction: LocalModeTransactionReader) {
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
