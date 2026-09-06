import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPackagedSchemaReader } from "./packaged-schema-reader.js";

export function createInstalledPackagedSchemaReader(
  input: Omit<Parameters<typeof createPackagedSchemaReader>[0], "packageRoot">
): (schemaId: string) => Promise<string> {
  return createPackagedSchemaReader({
    ...input,
    // Both src/ and dist/ retain this fixed feature-adapter depth in Foundation.
    packageRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..")
  });
}
