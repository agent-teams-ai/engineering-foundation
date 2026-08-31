export const LOCAL_STATE_DIRECTORY = ".agent-teams-local" as const;
export const LOCAL_OPERATION_LOCK = "foundation-operation.lock" as const;
export const TRANSACTION_FILE = "scaffolding-transaction.json" as const;
export const FOUNDATION_TRANSACTION_FILE = TRANSACTION_FILE;
export const TRANSACTION_TEMPORARY_FILE = `${TRANSACTION_FILE}.tmp` as const;
export const KNOWN_FILE_TRANSACTION_TEMPORARY_FILE = `${TRANSACTION_FILE}.known-file.tmp` as const;
