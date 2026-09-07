import type { FoundationTransactionSlot } from "./foundation-transaction-slot.js";

/** Exact installed identity and canonical operation root needed to select a slot. */
export interface FoundationTransactionSlotFactory {
  (options: {
    readonly consumerRoot: string;
    readonly installedVersion: string;
    readonly installedBuildIdentity: string;
  }): FoundationTransactionSlot;
}
