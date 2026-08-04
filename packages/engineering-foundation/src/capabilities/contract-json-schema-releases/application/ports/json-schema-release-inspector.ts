import type {
  JsonSchemaFixture,
  JsonSchemaInspection
} from "../model/json-schema-release.js";

export interface JsonSchemaReleaseInspector {
  inspect(
    input: {
      readonly consumerRoot: string;
      readonly schemaPaths: readonly string[];
      readonly fixtures: readonly JsonSchemaFixture[];
      readonly signal?: AbortSignal;
    }
  ): Promise<JsonSchemaInspection>;
}
