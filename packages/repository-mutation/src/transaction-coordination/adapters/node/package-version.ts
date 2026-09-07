import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";



export async function installedRepositoryMutationVersion(): Promise<string> {
  const value = JSON.parse(await readFile(fileURLToPath(new URL("../../../../package.json", import.meta.url)), "utf8")) as { version?: unknown };
  if (typeof value.version !== "string") {throw new Error("Installed Repository Mutation version is unavailable.");}
  return value.version;
}
