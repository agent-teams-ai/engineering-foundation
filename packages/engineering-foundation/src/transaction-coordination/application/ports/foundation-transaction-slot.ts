import type { FoundationTransactionStatus } from "../model/transaction-status.js";

export interface FoundationTransactionSlot {
  inspect(): Promise<FoundationTransactionStatus>;
}
