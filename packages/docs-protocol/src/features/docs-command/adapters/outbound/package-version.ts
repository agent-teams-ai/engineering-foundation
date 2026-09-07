import { readFile } from "node:fs/promises";
export async function readDocsPackageVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(new URL("../../../../../package.json", import.meta.url), "utf8"));
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest) || typeof manifest.version !== "string") {
    throw new TypeError("Docs Protocol package version is unavailable.");
  }
  return manifest.version;
}
