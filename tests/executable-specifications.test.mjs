import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { stringify as stringifyYaml } from "yaml";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distRoot = process.env.FOUNDATION_DIST_ROOT ?? join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
);
const capabilityModule = await import(
  pathToFileURL(join(distRoot, "capabilities", "executable-specifications", "module.js")).href,
);

async function write(root, path, content) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function writeJson(root, path, value) {
  await write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function schema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://schemas.example.test/specification/v1",
    type: "object",
    additionalProperties: false,
    required: ["id", "enabled"],
    properties: {
      id: { type: "string" },
      enabled: { type: "boolean" },
    },
  };
}

function gates() {
  return {
    typeGeneration: { packageName: "@example/specs", script: "spec:typegen" },
    property: { packageName: "@example/specs", script: "spec:property" },
    mutation: { packageName: "@example/specs", script: "spec:mutation" },
  };
}

function specification(stateModel = { kind: "none" }) {
  return {
    id: "workflow-contract",
    ownerDocs: ["docs/workflow.md"],
    adrRefs: ["docs/decisions/0001-workflow.md"],
    schemaPaths: ["specifications/workflow.schema.json"],
    documents: [
      {
        path: "specifications/workflow.json",
        schemaId: "https://schemas.example.test/specification/v1",
      },
    ],
    generatedTypes: [
      {
        schemaId: "https://schemas.example.test/specification/v1",
        outputPath: "src/generated/workflow.ts",
      },
    ],
    gateBindings: gates(),
    stateModel,
  };
}

async function materialize(root, catalog = { schemaVersion: 1, specifications: [specification()] }) {
  await write(
    root,
    "quality.yaml",
    stringifyYaml({ schemaVersion: 1, catalogPath: "architecture/specifications.json" }),
  );
  await writeJson(root, "architecture/specifications.json", catalog);
  await writeJson(root, "specifications/workflow.schema.json", schema());
  await writeJson(root, "specifications/workflow.json", { id: "created", enabled: true });
  await write(root, "docs/workflow.md", "# Workflow owner\n");
  await write(root, "docs/decisions/0001-workflow.md", "# Decision\n");
  await write(root, "src/generated/workflow.ts", "export interface Workflow {}\n");
  await writeJson(root, "package.json", {
    name: "@example/specs",
    scripts: {
      "spec:typegen": "consumer-owned-type-generation",
      "spec:property": "consumer-owned-property-tests",
      "spec:mutation": "consumer-owned-mutation-tests",
      "spec:model": "consumer-owned-model-tests",
    },
  });
}

async function withFixture(callback, catalog) {
  const root = await mkdtemp(join(tmpdir(), "foundation-executable-specifications-"));
  try {
    await materialize(root, catalog);
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function run(root) {
  return capabilityModule.createExecutableSpecificationsCapability().run({
    consumerRoot: root,
    configPath: "quality.yaml",
  });
}

test("accepts a connected JSON-first executable specification without running gates", async () => {
  await withFixture(async (root) => {
    const first = await run(root);
    const second = await run(root);
    assert.equal(first.outcome, "passed");
    assert.deepEqual(first, second);
  });
});

test("accepts a connected XState model without importing or executing XState", async () => {
  const stateModel = {
    kind: "xstate",
    axes: ["lifecycle", "delivery"],
    modelPath: "src/specification/workflow-machine.ts",
    adapterPath: "src/specification/workflow-adapter.ts",
    tracesPath: "specifications/workflow-traces.json",
    diagramPath: "docs/workflow-state.md",
    gateBinding: { packageName: "@example/specs", script: "spec:model" },
  };
  await withFixture(async (root) => {
    await write(root, stateModel.modelPath, "export const workflowMachine = {};\n");
    await write(root, stateModel.adapterPath, "export const adaptWorkflow = () => ({});\n");
    await writeJson(root, stateModel.tracesPath, []);
    await write(root, stateModel.diagramPath, "# Workflow state diagram\n");
    assert.equal((await run(root)).outcome, "passed");
  }, { schemaVersion: 1, specifications: [specification(stateModel)] });
});

test("reports document drift with stable schema and corpus digests", async () => {
  await withFixture(async (root) => {
    await writeJson(root, "specifications/workflow.json", { id: 42, enabled: "yes" });
    const first = await run(root);
    const second = await run(root);
    assert.equal(first.outcome, "violations");
    assert.deepEqual(first, second);
    const violation = first.diagnostics.find(
      ({ ruleId }) => ruleId === "quality.executable-specifications.document-invalid",
    );
    assert.ok(violation);
    assert.match(violation.evidence[0].value, /^sha256:[a-f0-9]{64}$/u);
    assert.match(violation.evidence[1].value, /^sha256:[a-f0-9]{64}$/u);
  });
});

test("reports missing package scripts and distinct gate reuse", async () => {
  const duplicate = specification();
  duplicate.gateBindings.mutation = duplicate.gateBindings.property;
  await withFixture(async (root) => {
    const manifest = {
      name: "@example/specs",
      scripts: { "spec:typegen": "typegen" },
    };
    await writeJson(root, "package.json", manifest);
    const result = await run(root);
    assert.equal(result.outcome, "violations");
    assert.deepEqual(
      [...new Set(result.diagnostics.map(({ ruleId }) => ruleId))],
      [
        "quality.executable-specifications.gate-missing",
        "quality.executable-specifications.gate-not-distinct",
      ],
    );
  }, { schemaVersion: 1, specifications: [duplicate] });
});

test("rejects duplicate generated schema bindings and output collisions", async () => {
  const duplicate = specification();
  duplicate.generatedTypes.push({
    schemaId: duplicate.generatedTypes[0].schemaId,
    outputPath: duplicate.generatedTypes[0].outputPath,
  });
  await withFixture(async (root) => {
    const result = await run(root);
    assert.equal(result.outcome, "violations");
    assert.ok(
      result.diagnostics.some(
        ({ ruleId }) =>
          ruleId === "quality.executable-specifications.generated-type-binding-duplicate",
      ),
    );
    assert.ok(
      result.diagnostics.some(
        ({ ruleId }) => ruleId === "quality.executable-specifications.path-collision",
      ),
    );
  }, { schemaVersion: 1, specifications: [duplicate] });
});

test("rejects duplicate specification identities deterministically", async () => {
  const first = specification();
  const second = specification();
  second.generatedTypes[0].outputPath = "src/generated/workflow-copy.ts";
  second.documents[0].path = "specifications/workflow-copy.json";
  await withFixture(async (root) => {
    await write(root, second.generatedTypes[0].outputPath, "export interface Copy {}\n");
    await writeJson(root, second.documents[0].path, { id: "copy", enabled: true });
    const initial = await run(root);
    const replay = await run(root);
    assert.deepEqual(initial, replay);
    assert.ok(
      initial.diagnostics.some(
        ({ ruleId }) =>
          ruleId === "quality.executable-specifications.specification-id-duplicate",
      ),
    );
  }, { schemaVersion: 1, specifications: [first, second] });
});

test("rejects a document path bound more than once", async () => {
  const duplicate = specification();
  duplicate.documents.push({ ...duplicate.documents[0] });
  await withFixture(async (root) => {
    const result = await run(root);
    assert.equal(result.outcome, "violations");
    assert.ok(
      result.diagnostics.some(
        ({ ruleId, subject }) =>
          ruleId === "quality.executable-specifications.path-collision" &&
          subject.includes(":document-path:"),
      ),
    );
  }, { schemaVersion: 1, specifications: [duplicate] });
});

test("rejects XState models with fewer than two independent axes", async () => {
  const invalid = specification({
    kind: "xstate",
    axes: ["lifecycle"],
    modelPath: "src/model.ts",
    adapterPath: "src/adapter.ts",
    tracesPath: "specifications/traces.json",
    diagramPath: "docs/state.md",
    gateBinding: { packageName: "@example/specs", script: "spec:model" },
  });
  await withFixture(async (root) => {
    const result = await run(root);
    assert.equal(result.outcome, "invalid-input");
    assert.equal(result.problem.code, "SCHEMA_INVALID");
  }, { schemaVersion: 1, specifications: [invalid] });
});

test("rejects non-local schema references through the shared Ajv inspector", async () => {
  await withFixture(async (root) => {
    const external = schema();
    external.properties.payload = { $ref: "https://untrusted.example.test/remote.schema.json" };
    await writeJson(root, "specifications/workflow.schema.json", external);
    const result = await run(root);
    assert.equal(result.outcome, "invalid-input");
    assert.equal(result.problem.code, "JSON_SCHEMA_REFERENCE_NOT_LOCAL");
  });
});

test("rejects symlink traversal for catalog and artifacts", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is not generally available on Windows CI");
    return;
  }
  await withFixture(async (root) => {
    await rm(join(root, "docs", "workflow.md"));
    await symlink(join(root, "docs", "decisions", "0001-workflow.md"), join(root, "docs", "workflow.md"));
    const result = await run(root);
    assert.equal(result.outcome, "invalid-input");
    assert.equal(result.problem.code, "EXECUTABLE_SPECIFICATION_ARTIFACT_SYMLINK");
  });
});

test("rejects duplicate root catalog keys before schema validation", async () => {
  await withFixture(async (root) => {
    await write(
      root,
      "architecture/specifications.json",
      '{"schemaVersion":1,"schemaVersion":1,"specifications":[]}\n',
    );
    const result = await run(root);
    assert.equal(result.outcome, "invalid-input");
    assert.equal(result.problem.code, "EXECUTABLE_SPECIFICATION_CATALOG_DUPLICATE_KEY");
  });
});

test("rejects duplicate nested keys in governed JSON documents", async () => {
  await withFixture(async (root) => {
    await write(
      root,
      "specifications/workflow.json",
      '{"id":"created","enabled":true,"nested":{"value":1,"value":2}}\n',
    );
    const result = await run(root);
    assert.equal(result.outcome, "invalid-input");
    assert.equal(result.problem.code, "JSON_SCHEMA_DUPLICATE_KEY");
  });
});
