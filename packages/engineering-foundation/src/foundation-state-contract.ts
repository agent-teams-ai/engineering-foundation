export const LOCAL_STATE_DIRECTORY = ".agent-teams-local" as const;
export const LOCAL_OPERATION_LOCK = "foundation-operation.lock" as const;
export const FOUNDATION_LINK_STATE_FILE = "foundation-link.json" as const;
export const FOUNDATION_REGISTRY_BACKUP =
  "foundation-registry-backup" as const;
export const FOUNDATION_TRANSACTION_FILE =
  "scaffolding-transaction.json" as const;
export const FOUNDATION_TRANSACTION_TEMPORARY_FILE =
  `${FOUNDATION_TRANSACTION_FILE}.tmp` as const;
export const FOUNDATION_TRANSACTION_CLEANUP_RESIDUE_PREFIX =
  "foundation-transaction.cleanup-residue." as const;
