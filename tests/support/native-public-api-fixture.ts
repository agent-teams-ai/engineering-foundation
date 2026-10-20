import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { loadCapabilityConfig } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/inbound/configuration/load-capability-config.js";
import { createPublicApiExtractor } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/module.js";
import { loadStrictYamlFile } from "../../packages/engineering-foundation/dist/features/configuration-input/node.js";
import { assertSchema } from "../../packages/engineering-foundation/dist/schema-catalog.js";

const baselinePath = "architecture/public-api/public-api.json";
const packageName = "@fixture/public-api";
const stableItem = Object.freeze({
  canonicalReference: `${packageName}!stable:function(1)`, kind: "Function",
  parentReference: `${packageName}!`, parentKind: "EntryPoint",
  signature: "export declare function stable(value: string): string;",
});

/** Materialize a distinct native positive only for the copied synthetic fixture.
 * Its complete literal stable-function surface remains an independent oracle;
 * the original legacy baseline stays exact data and an active refusal control. */
export async function prepareNativePublicApiFixture(root: string): Promise<void> {
  const canonical = await realpath(root);
  const location = relative(await realpath(tmpdir()), canonical);
  assert(!isAbsolute(location) && location !== "" && !location.startsWith(".."));
  assert(basename(canonical).startsWith("foundation-public-api-"), "only owned disposable fixtures may be prepared");
  const policy = await loadCapabilityConfig({ readYaml: loadStrictYamlFile, assertSchema },
    canonical, "architecture/foundation/public-api-compatibility.yaml");
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.packages.length, 1);
  const owner = policy.packages[0]; assert(owner);
  assert.equal(owner.packageName, packageName);
  assert.equal(owner.releasedBaselinePath, baselinePath);
  const paths = owner.entrypoints.map(entry => entry.exportPath).toSorted();
  assert.deepEqual(paths, paths.length === 1 ? ["."] : [".", "./local-mode"]);
  const legacy = {
    schemaVersion: 1, packageName, packageVersion: "1.2.3", extractorVersion: "7.58.12",
    entrypoints: paths.map(exportPath => ({ exportPath, items: [stableItem] })),
  };
  const original = await readFile(join(canonical, baselinePath));
  const parsed: unknown = JSON.parse(original.toString("utf8"));
  assert.deepEqual(parsed, legacy);
  const retained = join(canonical, `retained-legacy-public-api.${paths.length}.json`);
  await writeFile(retained, original, { flag: "wx" });
  const snapshot = await createPublicApiExtractor().extract(canonical, owner, "1.2.3");
  assert.deepEqual(snapshot, { ...legacy, extractorVersion: "typescript-native/7.0.2" });
  assert.deepEqual(await readFile(join(canonical, baselinePath)), original);
  await writeFile(join(canonical, baselinePath), `${JSON.stringify(snapshot, null, 2)}\n`);
  assert.deepEqual(await readFile(retained), original);
}
