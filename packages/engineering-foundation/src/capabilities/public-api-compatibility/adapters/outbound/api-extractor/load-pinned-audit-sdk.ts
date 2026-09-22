import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ExtractorConfig } from "@microsoft/api-extractor";

// Private fixed SDK operation: no caller-controlled specifier or resolution root.
const require = createRequire(import.meta.url);
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor"));
export const pinnedCompiler: unknown = extractorRequire("typescript");
export const compilerPath = extractorRequire.resolve("typescript");
export const compilerLibraryRoot = dirname(compilerPath);
export const pinnedAbortSignalLibraryPath = join(compilerLibraryRoot, "lib.dom.d.ts");
export const tsdocBasePath = join(dirname(dirname(require.resolve("@microsoft/api-extractor"))), "extends", "tsdoc-base.json");
export function pinnedTsdocConfig(): NonNullable<Parameters<typeof ExtractorConfig.prepare>[0]["tsdocConfigFile"]> {
  const sdk = extractorRequire("@microsoft/tsdoc-config") as { readonly TSDocConfigFile: { loadFile(path: string): NonNullable<Parameters<typeof ExtractorConfig.prepare>[0]["tsdocConfigFile"]> } };
  return sdk.TSDocConfigFile.loadFile(tsdocBasePath);
}
