import type {
  JsonSchemaFixture,
  JsonSchemaInspection
} from "../model/json-schema-release.js";

export interface JsonSchemaReleaseInspector {
  inspect(
    input: {
      readonly consumerRoot: string;
      readonly schemaPaths: readonly string[];
      /** Supplied captured evidence is authoritative; missing bytes must not fall back to disk. */
      readonly evidenceReader?: (repositoryPath: string) => Promise<Uint8Array | undefined>;
      readonly fixtures: readonly JsonSchemaFixture[];
      readonly requireMixedExpectations?: boolean;
      readonly signal?: AbortSignal;
    }
  ): Promise<JsonSchemaInspection>;
}
