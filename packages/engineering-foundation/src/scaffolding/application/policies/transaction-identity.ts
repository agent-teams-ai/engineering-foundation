// Pure reserved identities retain their transaction-coordination owner.
export {
  LOCAL_STATE_DIRECTORY,
  FOUNDATION_TRANSACTION_FILE,
  FOUNDATION_TRANSACTION_TEMPORARY_FILE,
  FOUNDATION_TRANSACTION_CLEANUP_RESIDUE_PREFIX
} from "../../../transaction-coordination/api.js";
export type {
  FoundationRecoveryRoute,
  FoundationTransactionDiagnostic
} from "../../../transaction-coordination/application/model/transaction-status.js";
export type { InternalFoundationTransactionStatus } from "../../../transaction-coordination/application/model/internal-transaction-status.js";
