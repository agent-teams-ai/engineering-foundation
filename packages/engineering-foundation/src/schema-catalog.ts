// Module assembly: feature-owned schema contributions and concrete input adapters.
import { readDocumentAuthoringSchema } from "@agent-teams/document-authoring";

import { createInstalledPackagedSchemaReader, createContributedSchemaCatalog } from "./features/configuration-input/module.js";
import { containedFileObservation } from "./source-inventory/node.js";
import { FOUNDATION_SCHEMA_IDS } from "./schema-ids.js";
import { SCAFFOLD_SCHEMA_DEPENDENCIES } from "./scaffolding/schemas.js";
import { TRANSACTION_SCHEMA_DEPENDENCIES, TRANSACTION_SCHEMA_FILES } from "./transaction-coordination/schemas.js";

export const {
  assertSchema,
  isSchemaId: isFoundationSchemaId,
  readSchema: readFoundationSchema
} = createContributedSchemaCatalog({
  schemaIds: FOUNDATION_SCHEMA_IDS,
  dependencyContributions: [TRANSACTION_SCHEMA_DEPENDENCIES, SCAFFOLD_SCHEMA_DEPENDENCIES],
  readSchema: createInstalledPackagedSchemaReader({
    files: containedFileObservation,
    schemaFiles: TRANSACTION_SCHEMA_FILES,
    readAuthoringSchema: readDocumentAuthoringSchema
  })
});
