export const FOUNDATION_LINK_STATE_FILE = "foundation-link.json" as const;
export const FOUNDATION_REGISTRY_BACKUP =
  "foundation-registry-backup" as const;

export {
  FOUNDATION_TRANSACTION_FILE,
  FOUNDATION_TRANSACTION_TEMPORARY_FILE,
  KNOWN_FILE_TRANSACTION_TEMPORARY_FILE,
  FOUNDATION_TRANSACTION_CLEANUP_RESIDUE_PREFIX,
  LOCAL_OPERATION_LOCK,
  LOCAL_STATE_DIRECTORY
} from "./transaction-coordination/application/model/foundation-transaction-identity.js";
