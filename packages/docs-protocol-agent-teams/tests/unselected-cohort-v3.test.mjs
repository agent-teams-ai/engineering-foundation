import { validCohortV3, assertPreservedPolicyDocuments } from "./unselected-cohort-fixture.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import {
  loadUnselectedCohortV3,
  parseRecord,
} from "../dist/consumer-integration/adapters/unselected-cohort-v3-loader.js";
import { bindUnselectedCohortV3 } from "../dist/consumer-integration/application/policies/qualified-docs-cohort-v3.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root));
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const source = await read("../../architecture/foundation/docs-protocol-current-policy-v3.json");
const asset = await read("assets/runtime-policy.v1.json");
const projected = JSON.parse(asset);
const cohortSchema = JSON.parse(await read("schemas/qualified-docs-cohort/v3.schema.json"));
const assetSchema = JSON.parse(await read("schemas/managed-runtime-policy/v1.schema.json"));
const oldSchema = JSON.parse(await read("schemas/qualified-docs-cohort/v2.schema.json"));
const policySchema = JSON.parse(
  await read("../../architecture/contracts/docs-protocol-current-policy/v3.schema.json"),
);
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validatePolicy = ajv.compile(policySchema);
const validateAsset = ajv.compile(assetSchema);
const validateCohort = ajv.compile(cohortSchema);
const validateOld = ajv.compile(oldSchema);
const digest = (digit) => `sha256:${digit.repeat(64)}`;
const insertDuplicateKey = (sourceText, marker, insertion, atRoot = false) => {
  const position = sourceText.indexOf(marker);
  if (atRoot) {
    assert.equal(position, 0, "root object marker must be at the start");
    assert.ok(sourceText.startsWith("{\n"), "root object must start with a newline");
  } else {
    assert.ok(position > 0, `expected nested marker ${marker}`);
    assert.equal(
      sourceText.lastIndexOf(marker),
      position,
      `nested marker ${marker} must be unique`,
    );
  }
  const end = position + marker.length;
  return sourceText.slice(0, end) + insertion + sourceText.slice(end);
};
const pkg = { version: "1.0.0", integrity: `sha512-${"A".repeat(86)}==` };
const valid = () => validCohortV3(hash(source));

test("v3 policy is closed and the packed projection binds its exact bytes", async () => {
  const policy = JSON.parse(source);
  await assertPreservedPolicyDocuments(read, hash);
  assert.equal(
    hash(source),
    "sha256:7af41f44a6e522b8919ace5f85499747215ddd1955199584c34046ec95c4b141",
  );
  assert.equal(validatePolicy(policy), true, JSON.stringify(validatePolicy.errors));
  for (const [family, current] of [
    ["profile", 4],
    ["portableCommandEnvelope", 3],
  ]) {
    const missingCurrent = structuredClone(policy);
    missingCurrent.contracts[family].supported = missingCurrent.contracts[family].supported.filter(
      (generation) => generation !== current,
    );
    assert.equal(
      validatePolicy(missingCurrent),
      false,
      `${family}.supported must include current ${current}`,
    );
    const wrongPath = structuredClone(policy);
    wrongPath.contracts[family].currentSchemaPath =
      "packages/docs-protocol/schemas/missing/v9.schema.json";
    assert.equal(validatePolicy(wrongPath), false, `${family}.currentSchemaPath must be exact`);
  }
  for (const path of [
    policy.contracts.protocol.schemaPath,
    policy.contracts.profile.currentSchemaPath,
    policy.contracts.portableCommandEnvelope.currentSchemaPath,
  ]) {
    assert.ok((await read(`../../${path}`)).byteLength > 0, path);
  }
  const portableManifest = JSON.parse(await read("../docs-protocol/package.json"));
  assert.ok(
    portableManifest.exports["./qualification"],
    "declared portable qualification entrypoint",
  );
  const qualification = await import("@agent-teams/docs-protocol/qualification");
  assert.equal(
    typeof qualification[policy.contracts.portableQualificationReceipt.export],
    "function",
  );
  assert.equal(projected.sourceDigest, hash(source));
  assert.equal(validateAsset(projected), true, JSON.stringify(validateAsset.errors));
  assert.deepEqual(assetSchema.const, projected);
  assert.deepEqual(projected.productionDefault, policy.runtime.productionDefault);
  assert.deepEqual(projected.compatibilityLane, policy.runtime.compatibilityLane);
  assert.deepEqual(projected.managedCandidate, policy.managedCandidate);
  assert.deepEqual(projected.managedRuntime, policy.managedRuntime);
  assert.deepEqual(policy.runtime.productionDefault, {
    id: "node-26-production-default",
    status: "production-default",
    nodeMajor: 26,
    engine: "^26.0.0",
    qualificationVersion: "26.11.1",
    default: true,
    cutoverAuthorized: true,
  });
  assert.deepEqual(policy.runtime.compatibilityLane, {
    id: "node-24-compatibility",
    status: "compatibility-lane",
    nodeMajor: 24,
    engine: "^24.18.0",
    qualificationVersion: "24.21.0",
    default: false,
    cutoverAuthorized: false,
  });
  assert.deepEqual(policy.contracts.managed, {
    profile: 3,
    cohort: 2,
    qualificationReceipt: 3,
    runtime: "Node 24 production cohort only",
  });
  assert.deepEqual(policy.managedCandidate, {
    selected: false,
    cohortSchema: 3,
    consumerIntegrationProfile: 4,
    managedState: 3,
    qualificationReceipt: 1,
    runtimeLane: "node-26-managed-qualified",
    status: "candidate-unqualified",
  });
  assert.equal(policy.managedRuntime.lanes["node-24-production-default"].default, false);
  assert.equal(policy.managedRuntime.lanes["node-26-managed-qualified"].default, true);
  assert.equal(
    policy.managedRuntime.lanes["node-26-managed-qualified"].qualificationRuntime.nodeVersion,
    "26.11.1",
  );
  assert.equal(policy.history.preservedSchemas.length, 15);
  const protectedHistory = new Map(
    policy.history.preservedSchemas.map((item) => [item.path, item.sha256]),
  );
  assert.equal(
    protectedHistory.get(
      "packages/docs-protocol-agent-teams/schemas/docs-consumer-integration-profile/v3.schema.json",
    ),
    "sha256:c70a0c05aeb576c4301a2bea5514ec2f0dc81fd5d77a84d0e8721578fcec19fe",
  );
  assert.equal(
    protectedHistory.get(
      "packages/docs-protocol-agent-teams/schemas/docs-consumer-managed-state/v2.schema.json",
    ),
    "sha256:b1537e65d602d090e998244fc0d20cbad472b1b8a18528f6afdb214e744b5d4b",
  );
  assert.equal(
    protectedHistory.get(
      "packages/docs-protocol-agent-teams/schemas/docs-protocol-qualification-receipt/v3.schema.json",
    ),
    "sha256:cc8e8fb12c461bbce4922dec9996a42a79bbab010395c4f60821a6d588e738fe",
  );
  for (const item of policy.history.preservedSchemas) {
    assert.equal(hash(await read(`../../${item.path}`)), item.sha256, item.path);
  }
  for (const change of [
    (p) => {
      p.managedCandidate.selected = true;
    },
    (p) => {
      p.policyVersion = "2.0.0";
    },
    (p) => {
      p.runtime.productionDefault.default = false;
    },
    (p) => {
      p.runtime.productionDefault.qualificationVersion = "26.10.0";
    },
    (p) => {
      p.managedRuntime.lanes["node-24-production-default"].default = true;
    },
    (p) => {
      p.managedRuntime.lanes["node-26-managed-qualified"].qualificationRuntime.nodeVersion =
        "26.10.0";
    },
    (p) => {
      p.managedCandidate.qualificationReceipt = 4;
    },
  ]) {
    const bad = structuredClone(policy);
    change(bad);
    assert.equal(validatePolicy(bad), false);
  }
  assert.equal(validateAsset({ ...projected, sourceDigest: digest("e") }), false);
  const extraAsset = { ...projected, selected: true };
  assert.equal(validateAsset(extraAsset), false);
  const alteredLane = structuredClone(projected);
  alteredLane.managedRuntime.lanes["node-26-managed-qualified"].qualificationRuntime.nodeVersion =
    "26.11.0";
  assert.equal(validateAsset(alteredLane), false);
});

test("packed policy asset has an exact public artifact disposition", async () => {
  const manifest = JSON.parse(await read("package.json"));
  const config = parseYaml(
    (await read("../../architecture/foundation/public-api-compatibility.yaml")).toString("utf8"),
  );
  const managed = config.packages.find((entry) => entry.packageName === manifest.name);
  assert.equal(
    manifest.exports["./assets/runtime-policy.v1.json"],
    "./assets/runtime-policy.v1.json",
  );
  assert.deepEqual(managed.nonTypeExports, [
    { exportPath: "./assets/runtime-policy.v1.json", kind: "data" },
    { exportPath: "./package.json", kind: "data" },
    { exportPath: "./schemas/*", kind: "wildcard" },
  ]);
});

test("policy and schema admission rejects decoded duplicate keys before validation", async () => {
  for (const [name, bytes, nested] of [
    ["policy", asset, '\n  "managedRuntime": {'],
    ["schema", await read("schemas/managed-runtime-policy/v1.schema.json"), '\n  "const": {'],
  ]) {
    const sourceText = bytes.toString("utf8");
    for (const [scope, candidate] of [
      ["top-level", insertDuplicateKey(sourceText, "{", '"x":0,"x":1,', true)],
      ["nested", insertDuplicateKey(sourceText, nested, '"x":0,"x":1,')],
      ["escaped", insertDuplicateKey(sourceText, "{", '"x":0,"\\u0078":1,', true)],
    ]) {
      assert.notEqual(candidate, sourceText, `${name} ${scope} fixture must change`);
      assert.throws(
        () => parseRecord(candidate),
        { name: "StrictJsonError", failure: "duplicate-key" },
        `${name} ${scope}`,
      );
    }
  }
});

test("unselected v3 validates closed tuple, lanes, identity and packed policy references", async () => {
  assert.equal(validateCohort(valid()), true, JSON.stringify(validateCohort.errors));
  assert.equal(validateOld(valid()), false, "old reader must reject v3");
  assert.equal((await loadUnselectedCohortV3(JSON.stringify(valid()))).schemaVersion, 3);
  const defaultLane = valid();
  defaultLane.runtime.selectedLane = "node-24-production-default";
  defaultLane.runtime.node = ">=24.18.0 <25";
  defaultLane.runtime.qualificationRuntime.nodeVersion = "24.21.0";
  assert.equal(
    (await loadUnselectedCohortV3(JSON.stringify(defaultLane))).runtime.selectedLane,
    "node-24-production-default",
  );
  defaultLane.runtime.qualificationRuntime.nodeVersion = "26.11.1";
  await assert.rejects(loadUnselectedCohortV3(JSON.stringify(defaultLane)));
  for (const change of [
    (c) => {
      c.schemas.managedState = 2;
    },
    (c) => {
      delete c.schemas.qualificationReceipt;
    },
    (c) => {
      c.runtime.node = ">=24.18.0 <25";
    },
    (c) => {
      c.runtime.qualificationRuntime.nodeVersion = "24.21.0";
    },
    (c) => {
      c.runtime.qualificationRuntime.pnpmVersion = "11.19.0";
    },
    (c) => {
      delete c.runtime.policy;
    },
    (c) => {
      c.runtime.policy.version = "2.0.0";
    },
    (c) => {
      c.candidateDigest = digest("0");
    },
    (c) => {
      c.packages.docsProtocolMcp = pkg;
    },
    (c) => {
      c.recordDigest = digest("0");
    },
    (c) => {
      c.runtime.policy.digest = digest("8");
    },
    (c) => {
      c.runtime.policy.digest = hash(asset);
    },
    (c) => {
      c.upgradeFrom = [];
    },
    (c) => {
      c.upgradeFrom = [c.cohortId];
    },
    (c) => {
      c.rollbackTo = [c.cohortId];
    },
    (c) => {
      c.rollbackTo = ["unrelated-v1"];
    },
    (c) => {
      c.rollbackTo = ["prior-v2", "prior-v2"];
    },
    (c) => {
      c.upgradeFrom = ["prior-v2", "prior-v2"];
    },
  ]) {
    const bad = valid();
    change(bad);
    await assert.rejects(loadUnselectedCohortV3(JSON.stringify(bad)));
  }
  const duplicate = JSON.stringify(valid()).replace(
    '"schemaVersion":3',
    '"schemaVersion":3,"schemaVersion":3',
  );
  await assert.rejects(loadUnselectedCohortV3(duplicate));
  const nestedDuplicate = JSON.stringify(valid()).replace(
    '"selectedLane":"node-26-managed-qualified"',
    '"selectedLane":"node-26-managed-qualified","selectedLane":"node-24-production-default"',
  );
  await assert.rejects(loadUnselectedCohortV3(nestedDuplicate));
  const decodedDuplicate = JSON.stringify(valid()).replace(
    '"selectedLane":"node-26-managed-qualified"',
    '"selectedLane":"node-26-managed-qualified","selected\\u004cane":"node-24-production-default"',
  );
  await assert.rejects(loadUnselectedCohortV3(decodedDuplicate));
  await assert.rejects(
    loadUnselectedCohortV3(`${JSON.stringify(valid())}${" ".repeat(1024 * 1024)}`),
  );
});

test("packed Cohort v3 accepts real UTC seconds and rejects impossible calendar dates", async () => {
  for (const eligibleAfter of [
    "2024-02-29T23:59:59Z",
    "2026-02-28T00:00:00Z",
    "2026-12-31T23:59:59Z",
  ]) {
    const candidate = valid();
    candidate.eligibleAfter = eligibleAfter;
    assert.equal(
      (await loadUnselectedCohortV3(JSON.stringify(candidate))).eligibleAfter,
      eligibleAfter,
    );
  }
  for (const eligibleAfter of [
    "2026-02-30T00:00:00Z",
    "2026-99-99T99:99:99Z",
    "2025-02-29T00:00:00Z",
  ]) {
    const candidate = valid();
    candidate.eligibleAfter = eligibleAfter;
    await assert.rejects(loadUnselectedCohortV3(JSON.stringify(candidate)), /eligibleAfter/);
  }
});

test("direct Cohort v3 binder admits real whole UTC seconds and rejects impossible dates", () => {
  const policy = {
    policyId: projected.policyId,
    policyVersion: projected.policyVersion,
    sourceDigest: projected.sourceDigest,
    pnpm: projected.managedRuntime.pnpm,
    lanes: projected.managedRuntime.lanes,
  };
  for (const eligibleAfter of [
    "2024-02-29T23:59:59Z",
    "2026-02-28T00:00:00Z",
    "2026-12-31T23:59:59Z",
  ]) {
    const candidate = valid();
    candidate.eligibleAfter = eligibleAfter;
    assert.equal(bindUnselectedCohortV3(candidate, policy), candidate);
  }
  for (const eligibleAfter of [
    "2026-02-30T00:00:00Z",
    "2026-99-99T99:99:99Z",
    "2025-02-29T00:00:00Z",
  ]) {
    const candidate = valid();
    candidate.eligibleAfter = eligibleAfter;
    assert.throws(() => bindUnselectedCohortV3(candidate, policy), /eligibleAfter/, eligibleAfter);
  }
});

test("direct Cohort v3 binder rejects fractional and explicit millisecond timestamps", () => {
  const policy = {
    policyId: projected.policyId,
    policyVersion: projected.policyVersion,
    sourceDigest: projected.sourceDigest,
    pnpm: projected.managedRuntime.pnpm,
    lanes: projected.managedRuntime.lanes,
  };
  for (const eligibleAfter of [
    "2026-09-28T00:00:00.999Z",
    "2026-09-28T00:00:00.001Z",
    "2026-09-28T00:00:00.000Z",
  ]) {
    const candidate = valid();
    candidate.eligibleAfter = eligibleAfter;
    assert.throws(() => bindUnselectedCohortV3(candidate, policy), /eligibleAfter/, eligibleAfter);
  }
});

test("direct Cohort v3 binder rejects an unknown selected lane with a controlled error", () => {
  const policy = {
    policyId: projected.policyId,
    policyVersion: projected.policyVersion,
    sourceDigest: projected.sourceDigest,
    pnpm: projected.managedRuntime.pnpm,
    lanes: projected.managedRuntime.lanes,
  };
  const candidate = valid();
  candidate.runtime.selectedLane = "node-99-unknown";
  assert.throws(() => bindUnselectedCohortV3(candidate, policy), {
    name: "TypeError",
    message: "Cohort v3 runtime differs from the packed managed policy lane.",
  });
});

test("direct Cohort v3 binder rejects wrong policy identity, digest, tuple and defaults", () => {
  const policy = {
    policyId: projected.policyId,
    policyVersion: projected.policyVersion,
    sourceDigest: projected.sourceDigest,
    pnpm: projected.managedRuntime.pnpm,
    lanes: projected.managedRuntime.lanes,
  };
  for (const mutate of [
    (candidate) => {
      candidate.runtime.policy.version = "2.0.0";
    },
    (candidate) => {
      candidate.runtime.policy.digest = digest("e");
    },
    (candidate) => {
      candidate.runtime.qualificationRuntime.nodeVersion = "26.10.0";
    },
  ]) {
    const candidate = valid();
    mutate(candidate);
    assert.throws(() => bindUnselectedCohortV3(candidate, policy), /runtime differs/);
  }
  for (const mutate of [
    (packed) => {
      packed.policyVersion = "2.0.0";
    },
    (packed) => {
      packed.lanes["node-24-production-default"].default = true;
    },
    (packed) => {
      packed.lanes["node-26-managed-qualified"].default = false;
    },
  ]) {
    const packed = structuredClone(policy);
    mutate(packed);
    assert.throws(() => bindUnselectedCohortV3(valid(), packed), /runtime differs/);
  }
});
