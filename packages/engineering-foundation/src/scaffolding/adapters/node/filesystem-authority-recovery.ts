import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  AuthorityScaffoldReceipt,
  AuthorityScaffoldRecoveryScope
} from "../../contract/types.js";
import { assertScaffoldRecoveryScopeMatchesPlan } from "../../kernel/recovery-scope.js";
import { LOCAL_STATE_DIRECTORY } from "../../../foundation-state-contract.js";
import { releaseFoundationTransactionLeaseSafely } from "../../../transaction-coordination/application/release-foundation-transaction-lease.js";
import { assertSafeOperationPaths } from "./filesystem-path-guard.js";
import { SCAFFOLD_JOURNAL_FILE } from "./node-scaffold-journal-evidence.js";
import {
  acquireScaffoldingTransaction,
  continueAuthorityScaffoldJournal,
  type ScaffoldAuthorityFaultInjector
} from "./filesystem-authority-workspace.js";
import { NodeScaffoldJournalStore } from "./node-scaffold-journal-store.js";
import { scaffoldTransactionEvidenceExists } from "./node-scaffold-journal-transaction-evidence.js";

export async function recoverAuthorityFilesystemScaffold(
  consumerRoot: string,
  scope?: AuthorityScaffoldRecoveryScope
): Promise<AuthorityScaffoldReceipt | undefined> {
  return recoverAuthorityFilesystemScaffoldWithFaultInjection(
    consumerRoot,
    scope
  );
}

/** Internal conformance seam. It is intentionally absent from package exports. */
export async function recoverAuthorityFilesystemScaffoldWithFaultInjection(
  consumerRoot: string,
  scope?: AuthorityScaffoldRecoveryScope,
  faultInjector?: ScaffoldAuthorityFaultInjector
): Promise<AuthorityScaffoldReceipt | undefined> {
  const canonicalRoot = await realpath(resolve(consumerRoot));
  const journalPath = join(
    canonicalRoot,
    LOCAL_STATE_DIRECTORY,
    SCAFFOLD_JOURNAL_FILE
  );
  const lease = await acquireScaffoldingTransaction(canonicalRoot);
  try {
    const journalStore = new NodeScaffoldJournalStore(canonicalRoot);
    const record = await journalStore.read();
    if (record === undefined) {
      return undefined;
    }
    if (scope !== undefined) {
      assertScaffoldRecoveryScopeMatchesPlan(scope, record.journal.plan);
      await faultInjector?.({ phase: "after-recovery-scope-checked" });
    }
    assertSafeOperationPaths(record.journal.plan);
    return await continueAuthorityScaffoldJournal({
      root: canonicalRoot,
      journalPath,
      record,
      journalStore,
      journalFaultContext: {},
      recovered: true,
      ...(faultInjector === undefined ? {} : { faultInjector })
    });
  } finally {
    await releaseFoundationTransactionLeaseSafely({
      lease,
      inspectRetainTransactionBarrier: () =>
        scaffoldTransactionEvidenceExists(journalPath)
    });
  }
}
