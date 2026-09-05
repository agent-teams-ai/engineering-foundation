import { resolve } from "node:path";

import { assertRepositoryRelativePath } from "../../../../../source-inventory/api.js";
import type { ConfigurationFileReader } from "../../../application/ports/configuration-file-reader.js";

const MAX_SCHEMA_BYTES = 1024 * 1024;

type AuthoringDependencyId = "document-intent/v1" | "document-plan/v1";

export function createPackagedSchemaReader(input: {
  readonly packageRoot: string;
  readonly files: ConfigurationFileReader;
  readonly schemaFiles?: Readonly<Record<string, string>>;
  readonly readAuthoringSchema: (schemaId: AuthoringDependencyId) => Promise<string>;
}): (schemaId: string) => Promise<string> {
  return async (schemaId) => {
    const selectedFile = input.schemaFiles !== undefined && Object.hasOwn(input.schemaFiles, schemaId)
      ? input.schemaFiles[schemaId] : undefined;
    if (selectedFile === undefined && (schemaId === "document-intent/v1" || schemaId === "document-plan/v1")) {
      return input.readAuthoringSchema(schemaId);
    }
    assertRepositoryRelativePath(schemaId, "schema-read");
    const relativeFile = selectedFile ?? `schemas/${schemaId}.schema.json`;
    assertRepositoryRelativePath(relativeFile, "schema-read");
    const bytes = await input.files.read({
      candidate: resolve(input.packageRoot, relativeFile),
      maxBytes: MAX_SCHEMA_BYTES,
      root: input.packageRoot
    });
    return Buffer.from(bytes).toString("utf8");
  };
}
