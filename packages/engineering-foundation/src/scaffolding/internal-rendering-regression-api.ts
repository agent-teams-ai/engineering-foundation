export {
  applyFilesystemScaffold,
  recoverFilesystemScaffold
} from "./adapters/node/filesystem-workspace.js";
export { readScaffoldPlanFile } from "./adapters/node/node-input-loader.js";
export { validateScaffoldReceipt } from "./adapters/node/node-receipt-validator.js";
export { MemoryScaffoldWorkspace } from "./adapters/memory/memory-workspace.js";
export { assertScaffoldPlanDigest } from "./kernel/rendering-plan-validation.js";
export { assertScaffoldReceiptDigest } from "./kernel/receipt.js";
export { planScaffoldFromFile } from "./service.js";
