export type PublicApiSchemaId =
  | "package-public-api-compatibility/v1"
  | "package-public-api-baseline/v1";

export type PublicApiSchemaAssertion =
  (schemaId: PublicApiSchemaId, input: unknown, phase: string) => Promise<void>;
