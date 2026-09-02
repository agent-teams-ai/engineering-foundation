import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function installedDocumentAuthoringVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(
    fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"
  )) as { readonly version?: unknown };
  if (typeof manifest.version !== "string") {
    throw new Error("Installed Document Authoring package version is unavailable.");
  }
  return manifest.version;
}
