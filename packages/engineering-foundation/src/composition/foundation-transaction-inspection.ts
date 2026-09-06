import { createNodeFoundationTransactionInspection } from "../transaction-coordination/composition/node-inspection.js";
import type { FoundationTransactionInspection, InstalledFoundationInspectionIdentity } from "../transaction-coordination/inspection.js";
import { inspectLegacyScaffoldingJournal, inspectLegacyScaffoldingEnvelope, inspectCurrentScaffoldingRecord } from "../scaffolding/composition/node-scaffolding.js";
import { assertSchema } from "../schema-catalog.js";

function legacyScaffoldingJournal(input: Parameters<typeof inspectLegacyScaffoldingJournal>[0]) {
  return inspectLegacyScaffoldingJournal(input, assertSchema);
}
function legacyScaffoldingEnvelope(value: Record<string, unknown>) {
  return inspectLegacyScaffoldingEnvelope(value, assertSchema);
}
const inspection = createNodeFoundationTransactionInspection(assertSchema, {
  legacyScaffoldingJournal,
  legacyScaffoldingEnvelope,
  currentScaffolding: inspectCurrentScaffoldingRecord
});

export function createFoundationTransactionInspection(
  installed: InstalledFoundationInspectionIdentity
): FoundationTransactionInspection {
  return inspection.createFoundationTransactionInspection(installed);
}
