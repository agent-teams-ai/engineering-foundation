// The check host owns the input it needs; composition chooses YAML and schema adapters.
export interface FoundationConfigInput {
  readonly loadStrictYamlFile: (
    consumerRoot: string,
    repositoryPath: string,
    phase: string,
    signal?: AbortSignal
  ) => Promise<unknown>;
  readonly assertSchema: (
    schemaId: "foundation-config/v1",
    input: unknown,
    phase: string
  ) => Promise<void>;
}
