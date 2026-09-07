import type { SchemaCatalog, SchemaCatalogInput } from "../../../application/schema-catalog.js";
import { createSchemaCatalog } from "./schema-catalog.js";

export function createContributedSchemaCatalog<SchemaId extends string>(input: {
  readonly schemaIds: readonly SchemaId[];
  readonly dependencyContributions: readonly [
    SchemaCatalogInput<SchemaId>["dependencies"],
    SchemaCatalogInput<SchemaId>["dependencies"]
  ];
  readonly readSchema: SchemaCatalogInput<SchemaId>["readSchema"];
}): SchemaCatalog<SchemaId> {
  return createSchemaCatalog({
    schemaIds: input.schemaIds,
    dependencies: { ...input.dependencyContributions[0], ...input.dependencyContributions[1] },
    readSchema: input.readSchema
  });
}
