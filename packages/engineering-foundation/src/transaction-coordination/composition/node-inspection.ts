import { inspectDocumentTransactionStatus } from "../adapters/node/document-transaction-status.js";
import { inspectLegacyDocumentTransaction } from "../adapters/node/legacy-document-transaction-status.js";
import { inspectKnownFileTransactionStatus } from "../adapters/node/known-file-transaction-status.js";
import { inspectSchema6TransactionStatus } from "../adapters/node/schema6-transaction-status.js";
import {
  createFoundationTransactionInspection as createInspection,
  type FoundationTransactionInspection,
  type InstalledFoundationInspectionIdentity
} from "../inspection.js";
import type { FoundationTransactionInspectors } from "../application/ports/foundation-transaction-inspection.js";

export function createNodeFoundationTransactionInspection(
  assertSchema: Parameters<typeof inspectLegacyDocumentTransaction>[1],
  scaffolding: Pick<FoundationTransactionInspectors, "legacyScaffoldingJournal" | "legacyScaffoldingEnvelope" | "currentScaffolding">
) {
  return {
    createFoundationTransactionInspection(installed: InstalledFoundationInspectionIdentity): FoundationTransactionInspection {
      return createInspection(installed, {
        legacyScaffoldingJournal: scaffolding.legacyScaffoldingJournal,
        legacyScaffoldingEnvelope: scaffolding.legacyScaffoldingEnvelope,
        legacyDocument: (value) => inspectLegacyDocumentTransaction(value, assertSchema),
        document: inspectDocumentTransactionStatus,
        knownFile: inspectKnownFileTransactionStatus,
        currentScaffolding: scaffolding.currentScaffolding,
        schema6: inspectSchema6TransactionStatus
      });
    }
  };
}
