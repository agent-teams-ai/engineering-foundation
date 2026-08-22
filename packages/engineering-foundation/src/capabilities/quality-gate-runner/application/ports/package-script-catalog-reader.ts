import type { PackageScriptCatalog } from "../model/quality-gate.js";

export interface PackageScriptCatalogReader {
  read(consumerRoot: string, signal?: AbortSignal): Promise<PackageScriptCatalog>;
}
