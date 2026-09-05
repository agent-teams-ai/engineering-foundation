import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCapabilityConfig } from "../dist/capabilities/public-api-compatibility/adapters/inbound/configuration/load-capability-config.js";
import { MicrosoftPublicApiExtractor } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/microsoft-public-api-extractor.js";
import { loadStrictYamlFile } from "../dist/features/configuration-input/node.js";
import { assertSchema } from "../dist/schema-catalog.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = join(repositoryRoot, "packages/repository-mutation");
const fixtures = join(packageRoot, "tests/fixtures/public-api");

test("all Mutation entrypoints extract without leaking private composition ports", async () => {
  const config = await loadCapabilityConfig({ readYaml: loadStrictYamlFile, assertSchema },
    repositoryRoot, "architecture/foundation/public-api-compatibility.yaml");
  const policy = config.packages.find((item) => item.packageName === "@agent-teams/repository-mutation");
  assert.ok(policy);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const actual = await new MicrosoftPublicApiExtractor().extract(repositoryRoot, policy, manifest.version);
  const typedExports = Object.entries(manifest.exports)
    .filter(([, value]) => typeof value === "object" && typeof value.types === "string")
    .map(([name]) => name).toSorted();
  assert.equal(typedExports.length, 7);
  assert.deepEqual(actual.entrypoints.map((entrypoint) => entrypoint.exportPath).toSorted(), typedExports);
  for (const entrypoint of actual.entrypoints) {
    for (const item of entrypoint.items) {
      assert.doesNotMatch(item.signature, /KnownFileCoordination/u, item.canonicalReference);
    }
  }

  // Frozen API Extractor output from the published 0.1.0 archive, not generated
  // from this candidate. It retains function declarations and operation fields.
  const published = JSON.parse(await readFile(join(fixtures, "published-v0.1.0.json"), "utf8"));
  assert.equal(published.artifactSha256, "8f1bed04552f9fd09049fc0e69c919aa5e1da4b4ce2cc538e5c27819a444bfd2");
  let explicitReaderProjections = 0;
  for (const entrypoint of published.entrypoints) {
    const current = actual.entrypoints.find((item) => item.exportPath === entrypoint.exportPath);
    assert.ok(current, entrypoint.exportPath);
    for (const expected of entrypoint.items) {
      const item = current.items.find((candidate) => candidate.canonicalReference === expected.canonicalReference);
      assert.ok(item, `${entrypoint.exportPath}: ${expected.canonicalReference}`);
      const reader = /^readonly (classifyBoundedRegularFile|readBoundedRegularFile): typeof readBoundedRegularFile;$/u.exec(expected.signature);
      // The installed-consumer compiler checks both assignment directions for
      // these explicit callbacks. Other published signatures stay byte-exact.
      const signature = reader === null ? expected.signature
        : `readonly ${reader[1]}: (path: string, maximumBytes: number) => Promise<BoundedRegularFileRead>;`;
      assert.deepEqual(item, { ...expected, signature }, `${entrypoint.exportPath}: ${expected.canonicalReference}`);
      if (reader !== null) { explicitReaderProjections += 1; }
    }
  }
  assert.equal(explicitReaderProjections, 5);
});
