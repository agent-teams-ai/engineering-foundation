import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import { importInstalledQualification } from "../scripts/node-engine-compatibility.mjs";

const schemaPath = "architecture/contracts/docs-protocol-current-policy/v1.schema.json";
const policyPath = "architecture/foundation/docs-protocol-current-policy.json";
const v2SchemaPath = "architecture/contracts/docs-protocol-current-policy/v2.schema.json";
const v2PolicyPath = "architecture/foundation/docs-protocol-current-policy-v2.json";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fromRoot = (path) => join(repositoryRoot, path);
const schema = JSON.parse(await readFile(fromRoot(schemaPath), "utf8"));
const policy = JSON.parse(await readFile(fromRoot(policyPath), "utf8"));
const validatePolicy = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const v2Schema = JSON.parse(await readFile(fromRoot(v2SchemaPath), "utf8"));
const v2Policy = JSON.parse(await readFile(fromRoot(v2PolicyPath), "utf8"));
const validateV2Policy = new Ajv2020({ allErrors: true, strict: true }).compile(v2Schema);

async function json(path) {
  return JSON.parse(await readFile(fromRoot(path), "utf8"));
}

test("current-policy schema rejects swapped and mixed runtime lane identities", () => {
  const swapped = structuredClone(policy);
  [swapped.runtime.productionDefault, swapped.runtime.compatibilityLane] =
    [swapped.runtime.compatibilityLane, swapped.runtime.productionDefault];
  assert.equal(validatePolicy(swapped), false);
  for (const slot of ["productionDefault", "compatibilityLane"]) {
    for (const key of ["id", "status", "nodeMajor", "engine", "qualificationVersion", "default"]) {
      const mixed = structuredClone(policy);
      mixed.runtime[slot][key] = policy.runtime[slot === "productionDefault" ? "compatibilityLane" : "productionDefault"][key];
      assert.equal(validatePolicy(mixed), false, `${slot}.${key}`);
    }
  }
});

test("current-policy schema rejects missing current generations and escaping schema paths", () => {
  for (const slot of ["profile", "portableCommandEnvelope"]) {
    const missing = structuredClone(policy);
    missing.contracts[slot].supported = [1, 2];
    assert.equal(validatePolicy(missing), false, `${slot}.supported`);
    for (const path of [
      "packages/docs-protocol/schemas/../../x/v1.schema.json",
      "packages/docs-protocol/schemas/x\\escape/v1.schema.json",
    ]) {
      const escaping = structuredClone(policy);
      escaping.contracts[slot].currentSchemaPath = path;
      assert.equal(validatePolicy(escaping), false, `${slot}: ${path}`);
    }
  }
});

test("v2 current policy binds each family's current generation, supported set and schema path", () => {
  assert.equal(validateV2Policy(v2Policy), true, JSON.stringify(validateV2Policy.errors, null, 2));
  const rejectsAt = (candidate, family, field, description) => {
    assert.equal(validateV2Policy(candidate), false, description);
    assert.ok(
      validateV2Policy.errors.some((error) => error.instancePath === `/contracts/${family}/${field}`),
      `${description}: ${JSON.stringify(validateV2Policy.errors)}`,
    );
  };
  for (const [family, otherFamily] of [
    ["profile", "portableCommandEnvelope"],
    ["portableCommandEnvelope", "profile"],
  ]) {
    const canonical = v2Policy.contracts[family];
    const withoutCurrent = structuredClone(v2Policy);
    withoutCurrent.contracts[family].supported = canonical.supported.filter(
      (generation) => generation !== canonical.current,
    );
    rejectsAt(withoutCurrent, family, "supported", `${family}: supported omits current`);

    const wrongCurrent = structuredClone(v2Policy);
    wrongCurrent.contracts[family].current = canonical.supported.find(
      (generation) => generation !== canonical.current,
    );
    rejectsAt(wrongCurrent, family, "current", `${family}: current differs from path`);

    const shiftedGeneration = structuredClone(v2Policy);
    shiftedGeneration.contracts[family].current = wrongCurrent.contracts[family].current;
    shiftedGeneration.contracts[family].currentSchemaPath = canonical.currentSchemaPath.replace(
      `/v${canonical.current}.schema.json`, `/v${wrongCurrent.contracts[family].current}.schema.json`,
    );
    rejectsAt(shiftedGeneration, family, "current", `${family}: v2 generation is fixed`);

    const wrongVersionPath = structuredClone(v2Policy);
    wrongVersionPath.contracts[family].currentSchemaPath = shiftedGeneration.contracts[family].currentSchemaPath;
    rejectsAt(wrongVersionPath, family, "currentSchemaPath", `${family}: path differs from current`);

    const wrongFamilyPath = structuredClone(v2Policy);
    wrongFamilyPath.contracts[family].currentSchemaPath = v2Policy.contracts[otherFamily].currentSchemaPath.replace(
      /\/v\d+\.schema\.json$/, `/v${canonical.current}.schema.json`,
    );
    rejectsAt(wrongFamilyPath, family, "currentSchemaPath", `${family}: path names another family`);
  }
});

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
  assert.equal((await readFile(fromRoot(".node-version"), "utf8")).trim(), policy.runtime.productionDefault.qualificationVersion);

  for (const [family, expectedPath] of [
    ["profile", "packages/docs-protocol/schemas/docs-protocol-profile"],
    ["portableCommandEnvelope", "packages/docs-protocol/schemas/docs-protocol-portable-command-envelope"],
  ]) {
    const generation = policy.contracts[family];
    assert.deepEqual(generation.supported, generation.supported.toSorted((left, right) => left - right));
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
    assert.equal(sha256(await readFile(fromRoot(preserved.path))), preserved.sha256, preserved.path);
  }
});

test("installed ESM qualification rejects missing and wrong public export targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-qualification-export-"));
  try {
    for (const [name, exports] of [
      ["missing", { ".": "./qualification.mjs" }],
      ["wrong-target", { "./qualification": "./absent.mjs" }],
      ["working", { "./qualification": "./qualification.mjs" }],
    ]) {
      const consumer = join(root, name);
      const installed = join(consumer, "node_modules", "@agent-teams", "docs-protocol");
      await mkdir(installed, { recursive: true });
      await writeFile(join(consumer, "package.json"), '{"type":"module"}\n');
      await writeFile(join(installed, "package.json"), JSON.stringify({ name: "@agent-teams/docs-protocol", type: "module", exports }));
      await writeFile(join(installed, "qualification.mjs"), "export function runDocsProtocolQualification() {}\n");
      if (name === "working") {
        const imported = await importInstalledQualification(consumer);
        assert.equal(typeof imported.runDocsProtocolQualification, "function");
      } else {
        await assert.rejects(importInstalledQualification(consumer), {
          code: name === "missing" ? "ERR_PACKAGE_PATH_NOT_EXPORTED" : "ERR_MODULE_NOT_FOUND",
        });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
