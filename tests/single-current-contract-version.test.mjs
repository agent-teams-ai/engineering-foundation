import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const packageRoot = join(repositoryRoot, "packages", "engineering-foundation");
const transactionEnvelopeV2Path =
  "schemas/foundation-transaction-envelope/v2.schema.json";

async function filesBelow(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...await filesBelow(path));
    } else if (entry.isFile()) {
      output.push(path);
    }
  }
  return output;
}

function assertOwnedNumericDiscriminatorsAreV1(value, source) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertOwnedNumericDiscriminatorsAreV1(entry, source);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  const properties = value.properties;
  if (properties !== null && typeof properties === "object") {
    for (const name of ["schemaVersion", "protocolVersion", "producerVersion", "version"]) {
      const property = properties[name];
      if (
        property !== null &&
        typeof property === "object" &&
        typeof property.const === "number"
      ) {
        assert.equal(property.const, 1, `${source} declares ${name}=${property.const}`);
      }
    }
  }
  for (const child of Object.values(value)) {
    assertOwnedNumericDiscriminatorsAreV1(child, source);
  }
}

test("ships v1 contracts plus the accepted transaction envelope v2 boundary", async () => {
  const schemaRoot = join(packageRoot, "schemas");
  const schemaFiles = (await filesBelow(schemaRoot)).filter((path) =>
    path.endsWith(".schema.json"),
  );
  const schemaRelativePaths = schemaFiles.map((path) =>
    relative(packageRoot, path).replaceAll("\\", "/"),
  );
  const nonV1SchemaPaths = schemaRelativePaths
    .filter((path) => !path.endsWith("/v1.schema.json"));
  assert.deepEqual(nonV1SchemaPaths, [transactionEnvelopeV2Path]);
  const forbiddenSchemaPaths = schemaRelativePaths
    .filter(
      (path) =>
        path !== transactionEnvelopeV2Path &&
        /\/v(?:[2-9]|[1-9][0-9]+)\.schema\.json$/u.test(path),
    );
  assert.deepEqual(forbiddenSchemaPaths, []);

  for (const path of schemaFiles) {
    const schema = JSON.parse(await readFile(path, "utf8"));
    const relativePath = relative(packageRoot, path).replaceAll("\\", "/");
    if (relativePath === transactionEnvelopeV2Path) {
      assert.equal(schema.$id.endsWith("/v2"), true);
      assert.equal(schema.properties.schemaVersion.const, 2);
      const nestedContracts = structuredClone(schema);
      nestedContracts.properties.schemaVersion.const = 1;
      assertOwnedNumericDiscriminatorsAreV1(nestedContracts, relativePath);
      continue;
    }
    assert.equal(
      typeof schema.$id === "string" && schema.$id.endsWith("/v1"),
      true,
      `Foundation-owned schema must use its sole current /v1 identity: ${relative(packageRoot, path)}`,
    );
    assertOwnedNumericDiscriminatorsAreV1(schema, relative(packageRoot, path));
  }

  const sourceFiles = (await filesBelow(join(packageRoot, "src"))).filter((path) =>
    path.endsWith(".ts"),
  );
  const forbiddenContractLiterals =
    /(?:schemaVersion|protocolVersion|producerVersion):\s*2\b/u;
  for (const path of sourceFiles) {
    assert.doesNotMatch(
      await readFile(path, "utf8"),
      forbiddenContractLiterals,
      `Current source declares a Foundation-owned v2 contract: ${relative(packageRoot, path)}`,
    );
  }

  const packageManifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  assert.deepEqual(
    packageManifest.files.filter((path) => path.endsWith("/v2.schema.json")),
    [transactionEnvelopeV2Path],
  );
});

test("documents the transaction envelope v2 migration and retirement gate", async () => {
  const decision = await readFile(
    join(repositoryRoot, "docs", "decisions", "0022-document-authoring-protocol.md"),
    "utf8",
  );
  assert.match(decision, /Compatibility direction and support window/u);
  assert.match(decision, /preserve it byte-for-byte/u);
  assert.match(decision, /Retirement requires organization inventory/u);
});

test("keeps upstream Buf v2 distinct from Foundation contract versions", async () => {
  const source = await readFile(
    join(
      packageRoot,
      "src",
      "capabilities",
      "contract-protobuf-evolution",
      "application",
      "model",
      "buf-breaking-qualification.ts",
    ),
    "utf8",
  );
  assert.equal(source.includes('{"version":"v2"'), true);

  const decision = await readFile(
    join(repositoryRoot, "docs", "decisions", "0019-single-current-foundation-contract-version.md"),
    "utf8",
  );
  assert.match(decision, /Buf config `version: v2`/u);
  assert.match(decision, /outside this rule/u);
});
