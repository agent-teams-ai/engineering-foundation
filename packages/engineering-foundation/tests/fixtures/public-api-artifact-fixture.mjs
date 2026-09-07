import { readContainedRegularFile, pathTraversesSymbolicLink } from "../../dist/source-inventory/node.js";
import { parseStrictYamlSource } from "../../dist/features/configuration-input/yaml.js";
import { assertSchema } from "../../dist/schema-catalog.js";
export { assertSchema };
export const evidence = { files: { read: readContainedRegularFile }, paths: { traversesSymbolicLink: pathTraversesSymbolicLink }, parseYaml: parseStrictYamlSource };
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemPackageArtifactInventory } from "../../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/filesystem-package-artifact-inventory.js";
import { AjvJsonSchemaReleaseInspector } from "../../dist/capabilities/contract-json-schema-releases/module.js";
import { NodeChangeFingerprint } from "../../dist/capabilities/public-api-compatibility/adapters/outbound/crypto/node-change-fingerprint.js";
import { writeArtifactBaseline } from "../../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/public-api-artifact-baseline.js";

export const fingerprint = new NodeChangeFingerprint();
export const inventory = new FilesystemPackageArtifactInventory(new AjvJsonSchemaReleaseInspector(evidence.files), evidence);
export const packagePolicy = {
  packageName: "@fixture/library", packageRoot: "package", manifestPath: "package/package.json",
  tsconfigPath: "package/tsconfig.json", releasedBaselinePath: "architecture/public-api/library.json",
  entrypoints: [], nonTypeExports: [{ exportPath: "./schemas/*", kind: "wildcard" }], approvedBreakingChanges: [],
};
export const policy = { schemaVersion: 1, acceptedDecisionBaselinePath: "architecture/decisions/accepted-decisions.json",
  changesetDirectory: ".changeset", packages: [packagePolicy] };
export const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://fixture.test/record/v1",
  type: "object", additionalProperties: false, required: ["schemaVersion", "value"],
  properties: { schemaVersion: { const: 1 }, value: { type: "string" } } };

export async function json(root, path, value) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
}
export async function fixture(t, version = "1.2.0") {
  const root = await mkdtemp(join(tmpdir(), "ef-schema-exports-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await json(root, "package/package.json", { name: packagePolicy.packageName, version,
    exports: { "./schemas/*": "./schemas/*" } });
  await json(root, "package/schemas/v1.schema.json", schema);
  await mkdir(join(root, "architecture/public-api"), { recursive: true });
  await mkdir(join(root, ".changeset"));
  return root;
}
export async function inspect(root, packages = [packagePolicy]) { return (await inventory.inspect(root, packages))[0]; }
export async function fixate(root, snapshot) {
  await writeArtifactBaseline({ root, policy: packagePolicy, snapshot: { ...snapshot, status: "supported" }, mode: "create" }, evidence);
}
