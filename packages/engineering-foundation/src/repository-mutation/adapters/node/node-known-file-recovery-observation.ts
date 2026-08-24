import { join } from "node:path";

import { LOCAL_STATE_DIRECTORY } from "../../../foundation-state-contract.js";
import { installedFoundationVersion } from "../../../package-version.js";
import { installedFoundationBuildIdentity } from "../../../transaction-coordination/adapters/node/installed-foundation-build-identity.js";
import type {
  KnownFileTransactionEnvelopeV1,
  KnownFileTransactionJournalV1
} from "../../application/model/known-file-transaction-journal.js";
import type { InstalledKnownFileRecoveryBuild } from "../../application/policies/classify-known-file-recovery-transition.js";
import {
  KnownFileTransactionError,
  matchesKnownFileImage,
  maximumKnownFileEvidenceBytes,
  observeKnownFile
} from "./node-known-file-transaction-filesystem.js";
import {
  NodeKnownFileTransactionJournalStore,
  type KnownFileJournalAuthority
} from "./node-known-file-transaction-journal-store.js";

export interface StoredKnownFileRecoveryJournal {
  authority: KnownFileJournalAuthority;
  envelope: KnownFileTransactionEnvelopeV1;
}

export interface KnownFileRecoveryEvidence {
  readonly installedBuild: InstalledKnownFileRecoveryBuild;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: StoredKnownFileRecoveryJournal;
}

export async function observeKnownFileRecoveryEvidence(
  root: string
): Promise<KnownFileRecoveryEvidence> {
  const store = new NodeKnownFileTransactionJournalStore(join(root, LOCAL_STATE_DIRECTORY));
  await store.canonicalizeTemporary();
  const observed = await store.read();
  if (observed === undefined) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_JOURNAL_MISSING",
      "Known-file recovery journal disappeared."
    );
  }
  const [version, buildIdentity] = await Promise.all([
    installedFoundationVersion(),
    installedFoundationBuildIdentity()
  ]);
  return {
    installedBuild: { buildIdentity, version },
    store,
    stored: observed
  };
}

export async function verifyRolledBackKnownFileState(
  root: string,
  journal: KnownFileTransactionJournalV1
): Promise<void> {
  for (const [index, operation] of journal.plan.operations.entries()) {
    const journalOperation = journal.operations[index]!;
    const observed = await observeKnownFile(
      root,
      operation.path,
      maximumKnownFileEvidenceBytes(operation)
    );
    if (journalOperation.state === "already-satisfied") {
      if (!matchesKnownFileImage(observed, operation.postimage)) {
        throw new KnownFileTransactionError(
          "KNOWN_FILE_RECOVERY_CONFLICT",
          `Unchanged guard drifted during rollback: ${operation.path}.`
        );
      }
      continue;
    }
    if (operation.precondition.state === "absent") {
      if (observed.state !== "absent") {
        throw new KnownFileTransactionError(
          "KNOWN_FILE_RECOVERY_CONFLICT",
          `Absent preimage was not restored: ${operation.path}.`
        );
      }
      continue;
    }
    const matched = journalOperation.matchedPreimage;
    if (matched === undefined ||
      !matchesKnownFileImage(observed, operation.precondition.acceptedPreimages[matched]!)) {
      throw new KnownFileTransactionError(
        "KNOWN_FILE_RECOVERY_CONFLICT",
        `Exact preimage was not restored: ${operation.path}.`
      );
    }
  }
}
