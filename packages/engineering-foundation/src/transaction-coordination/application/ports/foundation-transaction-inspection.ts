import type { InternalFoundationTransactionStatus } from "../model/internal-transaction-status.js";

/** The closed module assembly selects the owner before payload interpretation. */
export interface FoundationTransactionInspection {
  inspect(value: unknown): Promise<InternalFoundationTransactionStatus>;
}
