import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const packageRoot = join(repositoryRoot, "packages", "engineering-foundation");
const documentAuthoringPackageRoot = join(repositoryRoot, "packages", "document-authoring");
const repositoryMutationPackageRoot = join(repositoryRoot, "packages", "repository-mutation");
const transactionEnvelopeV2Path =
  "schemas/foundation-transaction-envelope/v2.schema.json";
const transactionEnvelopeV3Path =
  "schemas/foundation-transaction-envelope/v3.schema.json";
const transactionEnvelopeV4Path =
  "schemas/foundation-transaction-envelope/v4.schema.json";
const documentAuthoringProfileV2Path =
  "schemas/document-authoring-profile/v2.schema.json";
const documentAuthoringProfileV3Path =
  "schemas/document-authoring-profile/v3.schema.json";
const documentCommandEnvelopeV2Path =
  "schemas/document-command-envelope/v2.schema.json";
const documentParentMaterializationV2Path =
  "schemas/document-parent-materialization/v2.schema.json";
const documentPlanV2Path = "schemas/document-plan/v2.schema.json";
const documentReceiptV2Path = "schemas/document-receipt/v2.schema.json";
const sourceDependenciesV2Path =
  "schemas/architecture-source-dependencies/v2.schema.json";
const enumeratedNonV1SchemaPathsByRoot = new Map([
  [packageRoot, [sourceDependenciesV2Path, transactionEnvelopeV2Path]],
  [documentAuthoringPackageRoot, [
    "schemas/document-authoring/document-plan/v2.schema.json",
    documentAuthoringProfileV2Path,
    documentAuthoringProfileV3Path,
    documentCommandEnvelopeV2Path,
    documentParentMaterializationV2Path,
    documentPlanV2Path,
    documentReceiptV2Path,
    transactionEnvelopeV3Path,
    transactionEnvelopeV4Path,
  ]],
  [repositoryMutationPackageRoot, []],
]);
// Schema namespace version and persisted envelope wire version are distinct.
// This inventory constrains the implementation; it does not grant ADR admission.
const transactionEnvelopeVersions = new Map([
  [transactionEnvelopeV2Path, 2],
  [transactionEnvelopeV3Path, 3],
  [transactionEnvelopeV4Path, 4],
  ["schemas/document-authoring/document-file-transaction-envelope/v1.schema.json", 3],
  ["schemas/document-authoring/document-directory-transaction-envelope/v1.schema.json", 4],
]);

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

test("ships only enumerated schema and persisted envelope generations", async () => {
  for (const [ownerRoot, enumeratedNonV1SchemaPaths] of enumeratedNonV1SchemaPathsByRoot) {
    const schemaFiles = (await filesBelow(join(ownerRoot, "schemas")))
      .filter((path) => path.endsWith(".schema.json"));
    const schemaRelativePaths = schemaFiles
      .map((path) => relative(ownerRoot, path).replaceAll("\\", "/"));
    assert.deepEqual(
      schemaRelativePaths.filter((path) => !path.endsWith("/v1.schema.json")),
      enumeratedNonV1SchemaPaths,
    );
    for (const path of schemaFiles) {
      const schema = JSON.parse(await readFile(path, "utf8"));
      const relativePath = relative(ownerRoot, path).replaceAll("\\", "/");
      if (enumeratedNonV1SchemaPaths.includes(relativePath) &&
        !transactionEnvelopeVersions.has(relativePath)) {
        const acceptedVersion = Number(relativePath.match(/\/v(\d+)\.schema\.json$/u)?.[1]);
        assert.equal(schema.$id.endsWith(`/v${acceptedVersion}`), true);
        assert.equal(schema.properties.schemaVersion.const, acceptedVersion);
        continue;
      }
      if (transactionEnvelopeVersions.has(relativePath)) {
        const envelopeVersion = transactionEnvelopeVersions.get(relativePath);
        assert.equal(schema.$id, `https://agent-teams.ai/${relativePath.replace(/\.schema\.json$/u, "")}`);
        assert.equal(schema.properties.schemaVersion.const, envelopeVersion);
        assert.equal(
          schema.properties.recoveryHandler.properties.contractVersion.const,
          envelopeVersion - 1,
        );
        const payloadKinds = schema.properties.payloadKind.enum ?? [
          schema.properties.payloadKind.const,
        ];
        assert.ok(payloadKinds.includes(`document-authoring-journal/v${envelopeVersion - 1}`));
        continue;
      }
      assert.equal(
        typeof schema.$id === "string" && schema.$id.endsWith("/v1"),
        true,
        `Package-owned schema must use its sole current /v1 identity: ${relative(ownerRoot, path)}`,
      );
      if (
        ownerRoot === repositoryMutationPackageRoot &&
        relativePath === "schemas/repository-mutation-transaction-envelope/v1.schema.json"
      ) {
        assert.equal(schema.properties.schemaVersion.const, 6);
        continue;
      }
      assertOwnedNumericDiscriminatorsAreV1(schema, relative(ownerRoot, path));
    }
    const packageManifest = JSON.parse(await readFile(join(ownerRoot, "package.json"), "utf8"));
    if (ownerRoot === packageRoot) {
      assert.deepEqual(packageManifest.files.filter(
        (path) => /\/v(?:[2-9]|[1-9][0-9]+)\.schema\.json$/u.test(path),
      ), enumeratedNonV1SchemaPaths);
    } else {
      assert.ok(packageManifest.files.includes("schemas"));
    }
  }

  const versionedContractLiterals =
    /(?:schemaVersion|protocolVersion|producerVersion):\s*([2-9]|[1-9][0-9]+)\b/gu;
  const enumeratedVersionedSourceLiteralsByRoot = new Map([
    [packageRoot, {
      "src/capabilities/source-dependencies/application/model/source-workspace.ts": [2],
      "src/capabilities/source-dependencies/adapters/inbound/configuration/parse-capability-config.ts": [2],
      "src/transaction-coordination/adapters/node/schema6-transaction-status.ts": [6],
    }],
    [documentAuthoringPackageRoot, {
      "src/document-authoring/adapters/node/load-validated-document-authoring-profile-v2.ts": [2],
      "src/document-authoring/adapters/node/node-document-parent-materializer.ts": [2],
      "src/document-authoring/application/model/document-authoring-profile-description.ts": [2, 3],
      "src/document-authoring/application/model/document-command.ts": [2],
      "src/document-authoring/application/model/document-parent-materialization.ts": [2],
      "src/document-authoring/application/model/document-planning.ts": [2, 2],
      "src/document-authoring/application/model/document-receipt.ts": [2, 2],
      "src/document-authoring/application/model/document-transaction-inspection.ts": [2, 2, 2],
      "src/document-authoring/application/model/document-transaction.ts": [2, 3, 3, 4],
      "src/document-authoring/application/policies/document-authoring-semantic-digests.ts": [2],
      "src/document-authoring/application/policies/document-command-projection.ts": [2],
      "src/document-authoring/application/policies/document-receipt-policy.ts": [2, 2, 2, 2],
      "src/document-authoring/application/policies/document-transaction-envelope-body.ts": [
      3, 2, 2, 2, 2, 4, 3, 3, 3, 3, 3,
      ],
      "src/document-authoring/application/policies/document-transaction-envelope-policy.ts": [4],
      "src/document-authoring/application/use-cases/apply-document-plan.ts": [2, 2],
      "src/document-authoring/application/use-cases/compile-document-plan.ts": [2, 2],
      "src/document-authoring/application/use-cases/document-parent-materialization-continuation.ts": [2],
      "src/document-authoring/application/use-cases/document-transaction-continuation.ts": [2],
      "src/document-authoring/application/use-cases/document-transaction-receipts.ts": [2, 2],
      "src/document-authoring/application/use-cases/recapture-directory-receipt-evidence.ts": [2],
      "src/document-authoring/application/use-cases/recover-document-transaction.ts": [2, 2],
      "src/document-authoring/application/policies/project-document-authoring-description.ts": [2, 3],
      "src/document-authoring/adapters/node/inspect-document-transaction.ts": [2, 2, 2],
      "src/document-authoring/application/policies/project-document-transaction-inspection.ts": [2, 2, 2],
      "src/document-authoring/application/model/validated-document-authoring-profile.ts": [2, 3],
    }],
    [repositoryMutationPackageRoot, {
      "src/repository-mutation/application/model/known-file-transaction-journal.ts": [6],
      "src/transaction-coordination/application/repository-mutation-envelope.ts": [6, 6],
    }],
  ]);
  for (const [ownerRoot, enumeratedVersionedSourceLiterals] of enumeratedVersionedSourceLiteralsByRoot) {
    const observedVersionedSourceLiterals = {};
    const sourceFiles = (await filesBelow(join(ownerRoot, "src"))).filter((path) =>
      path.endsWith(".ts"),
    );
    for (const path of sourceFiles) {
      const versions = [...(await readFile(path, "utf8")).matchAll(
        versionedContractLiterals,
      )].map((match) => Number(match[1]));
      if (versions.length > 0) {
        observedVersionedSourceLiterals[
          relative(ownerRoot, path).replaceAll("\\", "/")
        ] = versions;
      }
    }
    assert.deepEqual(
      observedVersionedSourceLiterals,
      enumeratedVersionedSourceLiterals,
      "only enumerated contracts may use newer numeric discriminators",
    );
  }
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

test("documents v4 as current while preserving exact v3 and manual v2", async () => {
  const protocol = await readFile(
    join(repositoryRoot, "docs", "architecture", "document-authoring-protocol.md"),
    "utf8",
  );
  assert.match(protocol, /Document Authoring recognizes immutable document envelopes v3 and v4/u);
  assert.match(
    protocol,
    /only the exact recorded Document Authoring version and build identity may\s+select `docs-recover`/u,
  );
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
