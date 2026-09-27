import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

const schemaPath = "architecture/contracts/docs-protocol-current-policy/v1.schema.json";
const policyPath = "architecture/foundation/docs-protocol-current-policy.json";
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const policy = JSON.parse(await readFile(policyPath, "utf8"));
const validatePolicy = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

test("versioned Docs Protocol current policy validates and keeps Node 24 as the default", () => {
  assert.equal(validatePolicy(policy), true, JSON.stringify(validatePolicy.errors, null, 2));
  assert.deepEqual(policy.runtime.productionDefault, {
    id: "node-24-production-default",
    status: "production-default",
    nodeMajor: 24,
    engine: "^24.18.0",
    qualificationVersion: "24.21.0",
    default: true,
    cutoverAuthorized: false,
  });
  assert.deepEqual(policy.runtime.compatibilityLane, {
    id: "node-26-compatibility",
    status: "compatibility-lane",
    nodeMajor: 26,
    engine: "^26.0.0",
    qualificationVersion: "26.10.0",
    default: false,
    cutoverAuthorized: false,
  });
});

test("current policy binds package engines, schema generations and the real qualification entrypoint", async () => {
  const manifestPaths = [
    "package.json",
    "packages/repository-mutation/package.json",
    "packages/document-authoring/package.json",
    "packages/engineering-foundation/package.json",
    "packages/docs-protocol/package.json",
    "packages/docs-protocol-mcp/package.json",
    "packages/docs-protocol-agent-teams/package.json",
  ];
  for (const path of manifestPaths) {
    const manifest = await json(path);
    assert.equal(manifest.engines.node, policy.runtime.packageEngine, path);
  }
  assert.equal((await readFile(".node-version", "utf8")).trim(), policy.runtime.productionDefault.qualificationVersion);

  for (const [family, expectedPath] of [
    ["profile", "packages/docs-protocol/schemas/docs-protocol-profile"],
    ["portableCommandEnvelope", "packages/docs-protocol/schemas/docs-protocol-portable-command-envelope"],
  ]) {
    const generation = policy.contracts[family];
    assert.deepEqual(generation.supported, [...generation.supported].sort((left, right) => left - right));
    assert.ok(generation.supported.includes(generation.current));
    assert.equal(generation.currentSchemaPath, `${expectedPath}/v${generation.current}.schema.json`);
    for (const version of generation.supported) {
      const candidate = await json(`${expectedPath}/v${version}.schema.json`);
      assert.equal(candidate.properties.schemaVersion.const, version);
    }
  }

  const docsManifest = await json("packages/docs-protocol/package.json");
  assert.equal(docsManifest.exports["./qualification"].import, "./dist/qualification/index.js");
  const qualification = await import("../packages/docs-protocol/dist/qualification/index.js");
  assert.equal(typeof qualification.runDocsProtocolQualification, "function");
});

test("current policy freezes historical v1, v2 and cohort schema bytes", async () => {
  assert.equal(policy.history.preservedSchemas.length, 12);
  for (const preserved of policy.history.preservedSchemas) {
    assert.equal(sha256(await readFile(preserved.path)), preserved.sha256, preserved.path);
  }
});
