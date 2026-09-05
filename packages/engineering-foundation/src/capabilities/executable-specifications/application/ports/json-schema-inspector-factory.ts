import type { JsonSchemaReleaseInspector } from "../../../contract-json-schema-releases/api.js";

/** The caller supplies the same bounded observation session used by all catalog artifacts. */
export type JsonSchemaInspectorFactory = (
  readArtifact: (repositoryPath: string) => Promise<Buffer | undefined>
) => JsonSchemaReleaseInspector;
