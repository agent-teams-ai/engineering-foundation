import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const packageRoot = join(repositoryRoot, "packages", "engineering-foundation");
const transactionEnvelopeV2Path =
  "schemas/foundation-transaction-envelope/v2.schema.json";
const transactionEnvelopeV3Path =
  "schemas/foundation-transaction-envelope/v3.schema.json";
const documentCommandEnvelopeV2Path =
  "schemas/document-command-envelope/v2.schema.json";
const acceptedNonV1SchemaPaths = [
  documentCommandEnvelopeV2Path,
  transactionEnvelopeV2Path,
  transactionEnvelopeV3Path,
];
const acceptedTransactionEnvelopePaths = [
  transactionEnvelopeV2Path,
  transactionEnvelopeV3Path,
];

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

test("ships v1 contracts plus the accepted transaction envelope v2 and v3 boundaries", async () => {
  const schemaRoot = join(packageRoot, "schemas");
  const schemaFiles = (await filesBelow(schemaRoot)).filter((path) =>
    path.endsWith(".schema.json"),
  );
  const schemaRelativePaths = schemaFiles.map((path) =>
    relative(packageRoot, path).replaceAll("\\", "/"),
  );
  const nonV1SchemaPaths = schemaRelativePaths
    .filter((path) => !path.endsWith("/v1.schema.json"));
  assert.deepEqual(nonV1SchemaPaths, acceptedNonV1SchemaPaths);
  const forbiddenSchemaPaths = schemaRelativePaths
    .filter(
      (path) =>
        !acceptedNonV1SchemaPaths.includes(path) &&
        /\/v(?:[2-9]|[1-9][0-9]+)\.schema\.json$/u.test(path),
    );
  assert.deepEqual(forbiddenSchemaPaths, []);

  for (const path of schemaFiles) {
    const schema = JSON.parse(await readFile(path, "utf8"));
    const relativePath = relative(packageRoot, path).replaceAll("\\", "/");
    if (relativePath === documentCommandEnvelopeV2Path) {
      assert.equal(schema.$id.endsWith("/v2"), true);
      assert.equal(schema.properties.schemaVersion.const, 2);
      continue;
    }
    if (acceptedTransactionEnvelopePaths.includes(relativePath)) {
      const envelopeVersion = relativePath === transactionEnvelopeV2Path ? 2 : 3;
      assert.equal(schema.$id.endsWith(`/v${envelopeVersion}`), true);
      assert.equal(schema.properties.schemaVersion.const, envelopeVersion);
      assert.equal(
        schema.properties.recoveryHandler.properties.contractVersion.const,
        envelopeVersion - 1,
      );
      const payloadKinds = schema.properties.payloadKind.enum ?? [
        schema.properties.payloadKind.const,
      ];
      assert.ok(payloadKinds.includes(
        `document-authoring-journal/v${envelopeVersion - 1}`,
      ));
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
  const versionedContractLiterals =
    /(?:schemaVersion|protocolVersion|producerVersion):\s*([2-9]|[1-9][0-9]+)\b/gu;
  const acceptedVersionedSourceLiterals = {
    "src/document-authoring/application/model/document-command.ts": [2],
    "src/document-authoring/application/policies/document-command-projection.ts": [2],
    "src/document-authoring/application/model/document-transaction.ts": [2, 3],
    "src/document-authoring/application/use-cases/document-transaction-continuation.ts": [
      3, 2, 2, 2, 2,
    ],
  };
  const observedVersionedSourceLiterals = {};
  for (const path of sourceFiles) {
    const versions = [...(await readFile(path, "utf8")).matchAll(
      versionedContractLiterals,
    )].map((match) => Number(match[1]));
    if (versions.length > 0) {
      observedVersionedSourceLiterals[
        relative(packageRoot, path).replaceAll("\\", "/")
      ] = versions;
    }
  }
  assert.deepEqual(
    observedVersionedSourceLiterals,
    acceptedVersionedSourceLiterals,
    "only the accepted document journal v2 and envelope v3 may use newer numeric discriminators",
  );

  const packageManifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  assert.deepEqual(packageManifest.files.filter(
    (path) => /\/v(?:[2-9]|[1-9][0-9]+)\.schema\.json$/u.test(path),
  ), acceptedNonV1SchemaPaths);
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

test("documents v3 as the current recoverable writer boundary while preserving v2", async () => {
  const protocol = await readFile(
    join(repositoryRoot, "docs", "architecture", "document-authoring-protocol.md"),
    "utf8",
  );
  assert.match(protocol, /reads the legacy\s+scaffolding journal, envelope v2, and envelope v3/u);
  assert.match(protocol, /Only envelope v3[^.]+may select `docs-recover`/su);
  assert.match(protocol, /Envelope v2 is preserved as manual-recovery evidence/u);
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
