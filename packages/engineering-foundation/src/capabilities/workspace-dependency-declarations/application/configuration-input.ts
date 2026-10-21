/** Schema validation belongs to the shared catalog, selected at composition. */
export type WorkspaceConfigurationSchemaAssertion = (
  schemaId: "workspace-dependency-declarations/v1" | "workspace-dependency-declarations/v2",
  input: unknown,
  phase: string
) => Promise<void>;
