import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
const schemaId =
  "https://schemas.agent-teams.ai/engineering-foundation/package-public-api-compatibility/v2";
function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  if (typeof value !== "string") {
    throw new Error("Invalid installed binary entrypoint");
  }
  return value;
}
export async function inspectSdkInstallation(consumerRoot: string) {
  const require = createRequire(join(consumerRoot, "package.json"));
  const installedManifest = require.resolve("@agent-teams/engineering-foundation/package.json");
  const manifest = record(JSON.parse(await readFile(installedManifest, "utf8")));
  const cli = join(
    dirname(installedManifest),
    text(record(manifest.bin)["agent-teams-foundation"]),
  );
  const schema = record(
    JSON.parse(
      await readFile(
        require.resolve("@agent-teams/engineering-foundation/schemas/package-public-api-compatibility/v2.schema.json"),
        "utf8",
      ),
    ),
  );
  assert.equal(schema.$id, schemaId);
  assert.equal(schema.additionalProperties, false);
  const compilerManifestPath = require.resolve("typescript/package.json");
  const compilerManifest = record(JSON.parse(await readFile(compilerManifestPath, "utf8")));
  const compiler = join(dirname(compilerManifestPath), text(record(compilerManifest.bin).tsc));
  return { installedManifest, cli, compiler };
}
