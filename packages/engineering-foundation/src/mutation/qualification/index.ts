/**
 * Qualification-only Node process adapter for repository-mutation harnesses.
 * Production consumers should depend on a ProcessRunner port instead.
 */
export { NodeProcessRunner } from "../../process-execution/node-process-runner.js";
export type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner
} from "../../process-execution/types.js";

/** Qualification-only crash seams retained for deterministic recovery evidence. */
export type { KnownFileRecoveryFaultInjector } from "../../repository-mutation/adapters/node/node-known-file-transaction-recovery.js";
export type {
  KnownFileTransactionFaultInjector,
  KnownFileTransactionFaultPoint
} from "../../repository-mutation/adapters/node/node-known-file-transaction.js";
