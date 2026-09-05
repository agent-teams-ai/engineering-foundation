import {
  LOCAL_OPERATION_LOCK, LOCAL_STATE_DIRECTORY, FOUNDATION_TRANSACTION_FILE,
  KNOWN_FILE_TRANSACTION_TEMPORARY_FILE
} from "../../../transaction-coordination/application-api.js";

/** Shared barrier slots plus the known-file feature's retained-evidence names. */
export const knownFileStateNames = Object.freeze({
  directory: LOCAL_STATE_DIRECTORY,
  operationLock: LOCAL_OPERATION_LOCK,
  journal: FOUNDATION_TRANSACTION_FILE,
  candidate: KNOWN_FILE_TRANSACTION_TEMPORARY_FILE,
  terminalEvidence: `${FOUNDATION_TRANSACTION_FILE}.completed-known-file-evidence`,
  quarantinePrefix: `${FOUNDATION_TRANSACTION_FILE}.known-file-quarantine.`
});
