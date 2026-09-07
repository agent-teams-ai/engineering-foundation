import { join } from "node:path";

import { assertPackageScriptCatalogActive, mapPackageScriptCatalog, rejectPackageScriptCatalog } from "../../../application/policies/quality-gate-input.js";
import type { PackageScriptObservation } from "../../../application/ports/package-script-observation.js";
import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";
import type { PackageScriptCatalogReader } from "../../../application/ports/package-script-catalog-reader.js";

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

export class FilesystemPackageScriptCatalogReader implements PackageScriptCatalogReader {
  constructor(private readonly observe: PackageScriptObservation) {}

  async read(consumerRoot: string, signal?: AbortSignal) {
    assertPackageScriptCatalogActive(signal);
    let input: unknown;
    try {
      const source = await this.observe({
        root: consumerRoot,
        candidate: join(consumerRoot, "package.json"),
        maxBytes: MAX_PACKAGE_JSON_BYTES
      });
      const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
      input = parseStrictJson(bytes.toString("utf8"));
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
