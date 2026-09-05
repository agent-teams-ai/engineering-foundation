import { join } from "node:path";

import { assertPackageScriptCatalogActive, mapPackageScriptCatalog, rejectPackageScriptCatalog } from "../../../application/policies/quality-gate-input.js";
import { readContainedRegularFile } from "../../../../../source-inventory/node.js";
import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";
import type { PackageScriptCatalogReader } from "../../../application/ports/package-script-catalog-reader.js";

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

export class FilesystemPackageScriptCatalogReader implements PackageScriptCatalogReader {
  async read(consumerRoot: string, signal?: AbortSignal) {
    assertPackageScriptCatalogActive(signal);
    let input: unknown;
    try {
      const source = await readContainedRegularFile({
        root: consumerRoot,
        candidate: join(consumerRoot, "package.json"),
        maxBytes: MAX_PACKAGE_JSON_BYTES
      });
      input = parseStrictJson(source.toString("utf8"));
    } catch (error) {
      rejectPackageScriptCatalog(
        `The consumer root package.json must be a stable strict JSON file: ${
          error instanceof Error ? error.message : "unavailable"
        }`
      );
    }
    assertPackageScriptCatalogActive(signal);
    return mapPackageScriptCatalog(input);
  }
}
