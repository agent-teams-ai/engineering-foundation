import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function installedFoundationVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../../../../package.json", import.meta.url)),
      "utf8"
    )
  ) as { version?: unknown };
  if (typeof manifest.version !== "string") {
    throw new Error("Installed Foundation package version is unavailable.");
  }
  return manifest.version;
}
