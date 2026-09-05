import {
  inspectCurrentScaffoldingRecord,
  inspectLegacyScaffoldingEnvelope,
  inspectLegacyScaffoldingJournal
} from "../scaffolding/adapters/node/scaffold-transaction-status.js";
import { inspectDocumentTransactionStatus } from "../transaction-coordination/adapters/node/document-transaction-status.js";
import { inspectLegacyDocumentTransaction } from "../transaction-coordination/adapters/node/legacy-document-transaction-status.js";
import { assertSchema } from "../schema-catalog.js";
import { inspectKnownFileTransactionStatus } from "../transaction-coordination/adapters/node/known-file-transaction-status.js";
import { inspectSchema6TransactionStatus } from "../transaction-coordination/adapters/node/schema6-transaction-status.js";
import {
  createFoundationTransactionInspection as createInspection,
  type FoundationTransactionInspection,
  type InstalledFoundationInspectionIdentity
} from "../transaction-coordination/inspection.js";

export function createFoundationTransactionInspection(
  installed: InstalledFoundationInspectionIdentity
): FoundationTransactionInspection {
  return createInspection(installed, {
    legacyScaffoldingJournal: (input) => inspectLegacyScaffoldingJournal(input, assertSchema),
    legacyScaffoldingEnvelope: (value) => inspectLegacyScaffoldingEnvelope(value, assertSchema),
    legacyDocument: (value) => inspectLegacyDocumentTransaction(value, assertSchema),
    document: inspectDocumentTransactionStatus,
    knownFile: inspectKnownFileTransactionStatus,
    currentScaffolding: inspectCurrentScaffoldingRecord,
    schema6: inspectSchema6TransactionStatus
  });
}
