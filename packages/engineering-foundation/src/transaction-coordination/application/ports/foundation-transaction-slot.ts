import type { InternalFoundationTransactionStatus } from "../model/internal-transaction-status.js";

export interface FoundationTransactionSlot {
  inspect(): Promise<InternalFoundationTransactionStatus>;
}
