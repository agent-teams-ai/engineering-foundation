import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import { applyKnownFileTransaction, compileKnownFileTransactionPlan } from "@agent-teams/repository-mutation";
import {
  assertConsumerIntegrationExecutionSchema, assertConsumerUpgradeExecutionSchema
} from "../dist/consumer-integration/adapters/consumer-integration-schema-validator.js";
import {
  execution, executionKinds, installedExecutionValidator, oldReceiptSubpath,
  readSchema, receiptFixtures, receiptSubpath, schemaSubpath, sha256
} from "./consumer-execution-schema-fixtures.mjs";

// Docs Protocol 0.4.1 source 16e19d1ff82ceb049198c2070d45ec9031ab6cef.
// Published split packages have distinct bytes at some identical schema IDs.
const historicalBytes = async (specifier) => specifier === oldReceiptSubpath
  ? readFile(new URL("../../../tests/support/historical-schemas/known-file-transaction-receipt/v1.schema.json", import.meta.url))
  : readFile(new URL(`./fixtures/historical-execution-schemas/${specifier.split("/").at(-2)}.json`, import.meta.url));
const historicalSchema = async (specifier) => JSON.parse(await historicalBytes(specifier));

const executionValidators = {
  integration: assertConsumerIntegrationExecutionSchema,
  upgrade: assertConsumerUpgradeExecutionSchema
};

const schemaRoot = new URL("../schemas/", import.meta.url);
const [cohortSchema, managedStateSchema] = await Promise.all([
  readFile(new URL("qualified-docs-cohort/v2.schema.json", schemaRoot), "utf8"),
  readFile(new URL("docs-consumer-managed-state/v2.schema.json", schemaRoot), "utf8")
]);
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(JSON.parse(cohortSchema));
const validate = ajv.compile(JSON.parse(managedStateSchema));

const digest = (character) => `sha256:${character.repeat(64)}`;
const integrity = (character) => `sha512-${character.repeat(86)}==`;

function validManagedState() {
  const packageCoordinate = { version: "1.2.3", integrity: integrity("A") };
  return {
    schemaVersion: 2,
    cohortId: "docs-2026-09-04-stable1",
    cohortAuthority: {
      channel: "stable",
      recordDigest: digest("1"),
      qualificationEventDigest: digest("2"),
      eligibleAfter: "2026-09-04T12:00:00Z",
      upgradeFrom: ["docs-2026-09-03-stable1"],
      rollbackTo: ["docs-2026-09-03-stable1"]
    },
    repository: {
      provider: "github",
      id: "123456789",
      nameWithOwner: "agent-teams-ai/docs-sandbox"
    },
    packages: {
      repositoryMutation: packageCoordinate,
      documentAuthoring: packageCoordinate,
      docsProtocol: packageCoordinate,
      docsProtocolAgentTeams: packageCoordinate,
      engineeringFoundation: packageCoordinate
    },
    schemas: {
      consumerIntegration: 3,
      managedState: 2,
      docsProtocol: 1
    },
    runtime: {
      node: ">=24.18.0 <25",
      pnpm: ">=11.17.0 <12",
      runtimeClosureDigest: digest("3")
    },
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    assets: {
      skillDigest: digest("4"),
      callerWorkflowDigest: digest("5"),
      assetCatalogDigest: digest("6"),
      transitionCatalogDigest: digest("7"),
      agentsRouteDigest: digest("8"),
      docsScriptsDigest: digest("9")
    },
    stateDigest: digest("a")
  };
}

test("accepts managed-state v2 only with the complete five-package cohort", () => {
  assert.equal(validate(validManagedState()), true, JSON.stringify(validate.errors));
});

test("rejects missing, additional, and malformed managed package coordinates", () => {
  const missing = validManagedState();
  delete missing.packages.repositoryMutation;
  assert.equal(validate(missing), false);

  const additional = validManagedState();
  additional.packages.unmanagedPackage = additional.packages.docsProtocol;
  assert.equal(validate(additional), false);

  const malformed = validManagedState();
  malformed.packages.documentAuthoring = {
    version: "latest",
    integrity: malformed.packages.documentAuthoring.integrity
  };
  assert.equal(validate(malformed), false);
});

test("rejects legacy or inferred schema versions", () => {
  for (const schemaVersion of [1, 3, undefined]) {
    const candidate = validManagedState();
    if (schemaVersion === undefined) {
      delete candidate.schemaVersion;
    } else {
      candidate.schemaVersion = schemaVersion;
    }
    assert.equal(validate(candidate), false);
  }

  const legacyTuple = validManagedState();
  legacyTuple.schemas = {
    consumerIntegration: 1,
    managedState: 1,
    docsProtocol: 1
  };
  assert.equal(validate(legacyTuple), false);
});

test("rejects unknown properties at every managed-state object boundary", () => {
  const unknownRoot = { ...validManagedState(), inferredLegacyState: true };
  assert.equal(validate(unknownRoot), false);

  for (const boundary of [
    "cohortAuthority",
    "repository",
    "packages",
    "schemas",
    "runtime",
    "assets"
  ]) {
    const unknownNested = validManagedState();
    unknownNested[boundary].inferredLegacyState = true;
    assert.equal(validate(unknownNested), false, boundary);
  }
});

// Execution and managed-state schemas are owned by this consumer-integration feature.
test("execution schemas preserve exact historical bytes and reject cross-generation native receipts", async () => {
  const fixtures = await receiptFixtures();
  const planSubpath = "@agent-teams/docs-protocol-agent-teams/schemas/docs-consumer-integration-plan/v1.schema.json";
  const frozen = [
    [schemaSubpath("integration", false), "445a9c3be1863a0b2ac36e0f6860adf177019a217c876532b9131195ef710944"],
    [schemaSubpath("upgrade", false), "f448db069fed4bd78e051633378063ef3464e8f50f7ef947124a10dedfaf40c4"],
    [planSubpath, "3e8b79b0e3830cfb9a0043e22ee44d2f1bad927c64d3fdad9c50cdddee56120b"],
    [oldReceiptSubpath, "c400abd7cef88a4c987ac4dcbff7ceb8e63913c553440c49624f58279d2f6a61"]
  ];
  for (const [specifier, expectedDigest] of frozen) {
    assert.equal(sha256(await historicalBytes(specifier)), expectedDigest);
  }
  const plan = await readSchema(planSubpath);
  const historicalPlan = await historicalSchema(planSubpath);
  for (const kind of executionKinds) {
    // Each historical registry closes only over its frozen archive generation.
    const oldAjv = new Ajv2020({ strict: true, allErrors: true });
    oldAjv.addSchema(historicalPlan);
    oldAjv.addSchema(await historicalSchema(oldReceiptSubpath));
    const old = oldAjv.compile(await historicalSchema(schemaSubpath(kind, false)));
    assert.equal(old(execution(kind, fixtures.old)), true, JSON.stringify(old.errors));
    assert.equal(old(execution(kind, fixtures.current)), false);
    assert.ok(old.errors.some(({ instancePath, keyword }) => instancePath === "/receipt/protocol" && keyword === "const"));

    const currentSchema = await readSchema(schemaSubpath(kind, true));
    const incomplete = new Ajv2020({ strict: true });
    incomplete.addSchema(plan);
    assert.throws(() => incomplete.compile(currentSchema), (error) =>
      error.missingRef === "https://agent-teams.ai/schemas/repository-mutation/known-file-transaction-receipt/v1");
    const current = new Ajv2020({ strict: true });
    current.addSchema(plan);
    current.addSchema(await readSchema(receiptSubpath));
    assert.equal(current.compile(currentSchema)(execution(kind, fixtures.current)), true);
    await executionValidators[kind](execution(kind, fixtures.current));
    await assert.rejects(executionValidators[kind](execution(kind, fixtures.old)), /receipt\/protocol/u);
    for (const hostile of [
      { ...execution(kind, fixtures.current), schemaVersion: 2 },
      { ...execution(kind, fixtures.current), extra: true },
      { ...execution(kind, fixtures.current), command: "consumer.unknown" },
      execution(kind, { ...fixtures.current, schemaVersion: 2 }),
      execution(kind, { ...fixtures.current, extra: true })
    ]) {
      await assert.rejects(executionValidators[kind](hostile), /validation failed/u);
    }
  }
  for (const [specifier, expectedDigest] of frozen) {
    assert.equal(sha256(await historicalBytes(specifier)), expectedDigest, "rejection preserves historical evidence");
  }
  assert.deepEqual(await receiptFixtures(), fixtures);
});

test("both execution validators admit native Mutation create, replace and replay receipts", {
  skip: process.platform === "win32" && "Known-file apply is unsupported on Windows; schema-only native fixtures run separately."
}, async (context) => {
  const { rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "managed-native-execution-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const before = Buffer.from("before\n");
  const after = Buffer.from("after\n");
  await writeFile(join(root, "existing.txt"), before, { mode: 0o644 });
  const plan = compileKnownFileTransactionPlan({ operations: [
    { path: "created.txt", precondition: { state: "absent" }, postimage: { bytes: after } },
    { path: "existing.txt", precondition: { state: "known-file", acceptedPreimages: [{ bytes: before, mode: 0o644 }] }, postimage: { bytes: after, mode: 0o644 } }
  ] });
  const applied = await applyKnownFileTransaction({ consumerRoot: root, plan });
  assert.deepEqual(applied.operations.map(({ outcome }) => outcome), ["created", "replaced"]);
  const replay = await applyKnownFileTransaction({ consumerRoot: root, plan });
  assert.equal(replay.outcome, "already-satisfied");
  for (const receipt of [applied, replay]) {
    assert.equal(receipt.protocol, "agent-teams.repository-mutation.known-file/v1");
    for (const kind of executionKinds) {
      await executionValidators[kind](execution(kind, receipt));
    }
    for (const layout of ["npm", "pnpm"]) {
      const invoke = await installedExecutionValidator(context, layout);
      const values = executionKinds.map((kind) => execution(kind, receipt));
      const observed = invoke(values);
      assert.deepEqual(observed.validation, [{ valid: true }, { valid: true }]);
      assert.deepEqual([observed.integration, observed.upgrade], values);
      assert.deepEqual(observed.codes, [0, 0]);
    }
  }
  assert.deepEqual(await readFile(join(root, "created.txt")), after);
  assert.deepEqual(await readFile(join(root, "existing.txt")), after);
});

for (const layout of ["npm", "pnpm"]) {
  test(`${layout} physical execution closure obeys relocated exports and validates whole command output`, async (context) => {
    const invoke = await installedExecutionValidator(context, layout, "relocated-export");
    const fixtures = await receiptFixtures();
    const values = executionKinds.map((kind) => execution(kind, fixtures.current));
    const valid = invoke(values);
    assert.deepEqual(valid.validation, [{ valid: true }, { valid: true }]);
    assert.deepEqual([valid.integration, valid.upgrade], values);
    assert.deepEqual(valid.codes, [0, 0]);
    for (const invalid of [
      executionKinds.map((kind) => execution(kind, fixtures.old)),
      values.map((value) => ({ ...value, extra: true }))
    ]) {
      const rejected = invoke(invalid);
      assert.ok(rejected.validation.every(({ valid: admitted }) => !admitted));
      assert.deepEqual(rejected.codes, [3, 3]);
      for (const envelope of [rejected.integration, rejected.upgrade]) {
        assert.equal(envelope.outcome, "blocked");
        assert.equal(envelope.receipt, undefined);
        assert.equal(envelope.issues[0].code, "DOCS_CONSUMER_EXECUTION_FAILURE");
      }
    }
  });
  for (const [fault, code] of [["missing-file", "ENOENT"], ["unexported", "ERR_PACKAGE_PATH_NOT_EXPORTED"], ["wrong-id", undefined]]) {
    test(`${layout} physical execution closure fails closed for ${fault}`, async (context) => {
      const invoke = await installedExecutionValidator(context, layout, fault);
      const fixtures = await receiptFixtures();
      const rejected = invoke(executionKinds.map((kind) => execution(kind, fixtures.current)));
      assert.equal(rejected.validation.length, 2);
      for (const result of rejected.validation) {
        assert.equal(result.valid, false);
        assert.equal(result.code, code);
        if (fault === "wrong-id") { assert.match(result.message, /can't resolve reference.*repository-mutation\/known-file-transaction-receipt/u); }
      }
      assert.deepEqual(rejected.codes, [3, 3]);
      assert.equal(rejected.integration.outcome, "blocked");
      assert.equal(rejected.upgrade.outcome, "blocked");
    });
  }
}
