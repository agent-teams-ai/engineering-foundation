// Module assembly: feature-owned schema contributions and concrete input adapters.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readDocumentAuthoringSchema } from "@agent-teams/document-authoring";

import { createPackagedSchemaReader, createSchemaCatalog } from "./features/configuration-input/module.js";
import { containedFileObservation } from "./source-inventory/node.js";
import { FOUNDATION_SCHEMA_IDS } from "./schema-ids.js";
import { SCAFFOLD_SCHEMA_DEPENDENCIES } from "./scaffolding/schemas.js";
import { TRANSACTION_SCHEMA_DEPENDENCIES } from "./transaction-coordination/schemas.js";

const catalog = createSchemaCatalog({
  schemaIds: FOUNDATION_SCHEMA_IDS,
  dependencies: { ...TRANSACTION_SCHEMA_DEPENDENCIES, ...SCAFFOLD_SCHEMA_DEPENDENCIES },
  readSchema: createPackagedSchemaReader({
    packageRoot: dirname(dirname(fileURLToPath(import.meta.url))),
    files: containedFileObservation,
    readAuthoringSchema: readDocumentAuthoringSchema
  })
});

export const {
  assertSchema,
  isSchemaId: isFoundationSchemaId,
  readSchema: readFoundationSchema
} = catalog;
