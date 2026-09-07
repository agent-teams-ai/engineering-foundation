export interface SchemaCatalogInput<SchemaId extends string> {
  readonly schemaIds: readonly SchemaId[];
  readonly dependencies: Readonly<Record<string, readonly string[] | undefined>>;
  readonly readSchema: (schemaId: string) => Promise<string>;
}

export interface SchemaCatalog<SchemaId extends string> {
  readonly assertSchema: (schemaId: SchemaId, input: unknown, phase: string) => Promise<void>;
  readonly isSchemaId: (value: string) => value is SchemaId;
  readonly readSchema: (schemaId: SchemaId) => Promise<string>;
}
