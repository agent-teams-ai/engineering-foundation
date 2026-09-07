import { createJsonSchemaInspector, executableArtifactFiles as artifactFiles, executableSpecificationAdapters } from "./support/capability-adapters.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

function dataOnlySpecification(stateModel = { kind: "none" }) {
  const candidate = specification(stateModel);
  candidate.generatedTypes = [];
  delete candidate.gateBindings.typeGeneration;
  return candidate;
}

function catalogOf(...specifications) {
  return {
    schemaVersion: 1,
    configPath: "quality.yaml",
    catalogPath: "architecture/specifications.json",
    specifications,
  };
}

function deliverySpecification() {
  const second = specification();
  second.id = "delivery-contract";
  second.ownerDocs = ["docs/delivery.md"];
  second.adrRefs = ["docs/decisions/0002-delivery.md"];
  second.schemaPaths = ["specifications/delivery.schema.json"];
  second.documents = [{
    path: "specifications/delivery.json",
    schemaId: "https://schemas.example.test/delivery/v1",
  }];
  second.generatedTypes = [{
    schemaId: "https://schemas.example.test/delivery/v1",
    outputPath: "src/generated/delivery.ts",
  }];
  return second;
}

async function materialize(root, catalog = { schemaVersion: 1, specifications: [specification()] }) {
  await write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
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
  return capabilityModule.createExecutableSpecificationsCapability(executableSpecificationAdapters()).run({
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

test("accepts a data-only specification without generated output or a type-generation gate", async () => {
  await withFixture(async (root) => {
    await rm(join(root, "src", "generated", "workflow.ts"));
    await writeJson(root, "package.json", {
      name: "@example/specs",
      scripts: {
        "spec:property": "consumer-owned-property-tests",
        "spec:mutation": "consumer-owned-mutation-tests",
      },
    });
    const result = await run(root);
    assert.equal(result.outcome, "passed");
    assert.equal(result.diagnostics.length, 0);
  }, { schemaVersion: 1, specifications: [dataOnlySpecification()] });
});

test("requires a type-generation gate when generated types are declared", async () => {
  const candidate = specification();
  delete candidate.gateBindings.typeGeneration;
  await withFixture(async (root) => {
    const result = await run(root);
    assert.equal(result.outcome, "invalid-input");
    assert.equal(result.problem.code, "SCHEMA_INVALID");
  }, { schemaVersion: 1, specifications: [candidate] });
});

test("forbids a type-generation gate when no generated types are declared", async () => {
  const candidate = dataOnlySpecification();
  candidate.gateBindings.typeGeneration = {
    packageName: "@example/specs",
    script: "spec:typegen",
  };
  await withFixture(async (root) => {
    const result = await run(root);
    assert.equal(result.outcome, "invalid-input");
    assert.equal(result.problem.code, "SCHEMA_INVALID");
  }, { schemaVersion: 1, specifications: [candidate] });
});

test("requires independent property and mutation gates for generated and data-only specs", async () => {
  for (const createCandidate of [specification, dataOnlySpecification]) {
    for (const gateRole of ["property", "mutation"]) {
      const candidate = createCandidate();
      delete candidate.gateBindings[gateRole];
      await withFixture(async (root) => {
        const result = await run(root);
        assert.deepEqual([result.outcome, result.problem.code], ["invalid-input", "SCHEMA_INVALID"]);
      }, { schemaVersion: 1, specifications: [candidate] });
    }
  }
});

test("rejects type-generation topology mismatches before inspector I/O", async () => {
  const generatedWithoutGate = specification();
  delete generatedWithoutGate.gateBindings.typeGeneration;
  const dataOnlyWithGate = dataOnlySpecification();
  dataOnlyWithGate.gateBindings.typeGeneration = gates().typeGeneration;
  for (const candidate of [generatedWithoutGate, dataOnlyWithGate]) {
    let inspections = 0;
    const diagnostics = await capabilityModule.analyzeExecutableSpecifications(
      { consumerRoot: "/not-used", catalog: catalogOf(candidate) },
      {
        async inspectCatalog() {
          inspections += 1;
          return [];
        },
      },
    );
    assert.equal(inspections, 0);
    assert.ok(
      diagnostics.some(
        ({ ruleId }) =>
          ruleId === "quality.executable-specifications.generated-type-gate-mismatch",
      ),
    );
  }
});

test("validates the capability config path before trying to read it", async () => {
  const result = await capabilityModule.createExecutableSpecificationsCapability(executableSpecificationAdapters()).run({
    consumerRoot: "/definitely-not-readable",
    configPath: "docs/CON.ts",
  });
  assert.equal(result.outcome, "invalid-input");
  assert.equal(result.problem.code, "EXECUTABLE_SPECIFICATION_PATH_NOT_PORTABLE");
});

test("does not accept a gate package outside the pnpm workspace", async () => {
  const candidate = specification();
  for (const binding of Object.values(candidate.gateBindings)) {
    binding.packageName = "@example/outside-gates";
  }
  await withFixture(async (root) => {
    await writeJson(root, "fixtures/outside/package.json", {
      name: "@example/outside-gates",
      scripts: {
        "spec:typegen": "outside-type-generation",
        "spec:property": "outside-property-tests",
        "spec:mutation": "outside-mutation-tests",
      },
    });
    const result = await run(root);
    assert.equal(result.outcome, "violations");
    assert.equal(
      result.diagnostics.filter(
        ({ ruleId }) => ruleId === "quality.executable-specifications.gate-missing",
      ).length,
      3,
    );
  }, { schemaVersion: 1, specifications: [candidate] });
});

test("ignores duplicate package names outside the pnpm workspace", async () => {
  await withFixture(async (root) => {
    await writeJson(root, "fixtures/duplicate/package.json", {
      name: "@example/specs",
      scripts: { "spec:typegen": "unrelated-fixture" },
    });
    assert.equal((await run(root)).outcome, "passed");
  });
});

test("accepts gate scripts from a declared pnpm workspace package", async () => {
  const candidate = specification();
  for (const binding of Object.values(candidate.gateBindings)) {
    binding.packageName = "@example/workspace-gates";
  }
  await withFixture(async (root) => {
    await writeJson(root, "packages/gates/package.json", {
      name: "@example/workspace-gates",
      scripts: {
        "spec:typegen": "workspace-type-generation",
        "spec:property": "workspace-property-tests",
        "spec:mutation": "workspace-mutation-tests",
      },
    });
    assert.equal((await run(root)).outcome, "passed");
  }, { schemaVersion: 1, specifications: [candidate] });
});

test("accepts connected zero-, single-, and multi-axis XState models without executing them", async () => {
  for (const axes of [[], ["consumer-defined-axis"], ["lifecycle", "delivery"]]) {
    const stateModel = { kind: "xstate", axes,
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
  }
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

test("rejects distinct gate reuse during topology preflight", async () => {
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
      ["quality.executable-specifications.gate-not-distinct"],
    );
  }, { schemaVersion: 1, specifications: [duplicate] });
});

test("rejects a gate script whose command contains only whitespace", async () => {
  await withFixture(async (root) => {
    await writeJson(root, "package.json", {
      name: "@example/specs",
      scripts: {
        "spec:typegen": "consumer-owned-type-generation",
        "spec:property": "  \t  ",
        "spec:mutation": "consumer-owned-mutation-tests",
      },
    });
    const result = await run(root);
    assert.equal(result.outcome, "violations");
    assert.ok(
      result.diagnostics.some(
        ({ ruleId, message }) =>
          ruleId === "quality.executable-specifications.gate-missing" &&
          message.includes("spec:property"),
      ),
    );
  });
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
          subject === "catalog-path:specifications/workflow.json",
      ),
    );
  }, { schemaVersion: 1, specifications: [duplicate] });
});

test("rejects repeated artifact topology before invoking any inspector I/O", async () => {
  const duplicate = specification();
  duplicate.documents.push({ ...duplicate.documents[0] });
  let inspections = 0;
  const diagnostics = await capabilityModule.analyzeExecutableSpecifications(
    {
      consumerRoot: "/definitely-not-readable",
      catalog: catalogOf(duplicate),
    },
    {
      async inspectCatalog() {
        inspections += 1;
        throw new Error("topology preflight performed I/O");
      },
    },
  );
  assert.equal(inspections, 0);
  assert.ok(
    diagnostics.some(
      ({ ruleId }) => ruleId === "quality.executable-specifications.path-collision",
    ),
  );
});

test("reserves catalog paths and compares topology with portable identities before I/O", async () => {
  const cases = [
    { owner: "docs/owner.md", output: "architecture/specifications.json" },
    { owner: "docs/owner.md", output: "quality.yaml" },
    { owner: "docs/owner.md", output: "foundation.config.yaml" },
    { owner: "Src/Model.ts", output: "src/model.ts" },
    { owner: "docs/caf\u00e9.md", output: "docs/cafe\u0301.md" },
  ];
  for (const paths of cases) {
    const candidate = specification();
    candidate.ownerDocs = [paths.owner];
    candidate.generatedTypes[0].outputPath = paths.output;
    let inspections = 0;
    const diagnostics = await capabilityModule.analyzeExecutableSpecifications(
      { consumerRoot: "/not-used", catalog: catalogOf(candidate) },
      {
        async inspectCatalog() {
          inspections += 1;
          return [];
        },
      },
    );
    assert.equal(inspections, 0);
    assert.ok(
      diagnostics.some(
        ({ ruleId }) => ruleId === "quality.executable-specifications.path-collision",
      ),
    );
  }
});

test("rejects non-portable and cross-role path aliases during pure topology preflight", async () => {
  const cases = [
    { owner: "docs/result", output: "docs/result." },
    { owner: "docs/./owner.md", output: "src/generated/workflow.ts" },
    { owner: "Docs/Owner.md", output: "docs/owner.md" },
    { owner: "docs/caf\u00e9.md", output: "docs/cafe\u0301.md" },
    { owner: "docs/\u03a3.md", output: "docs/\u03c2.md" },
  ];
  for (const paths of cases) {
    const candidate = specification();
    candidate.ownerDocs = [paths.owner];
    candidate.generatedTypes[0].outputPath = paths.output;
    let inspections = 0;
    const diagnostics = await capabilityModule.analyzeExecutableSpecifications(
      { consumerRoot: "/not-used", catalog: catalogOf(candidate) },
      {
        async inspectCatalog() {
          inspections += 1;
          return [];
        },
      },
    );
    assert.equal(inspections, 0);
    assert.ok(
      diagnostics.some(
        ({ ruleId }) => ruleId === "quality.executable-specifications.path-collision",
      ),
    );
  }
});

test("rejects Windows device, ADS, control, and trailing-space catalog paths", async () => {
  const invalidPaths = [
    "docs/CON.ts",
    "docs/./owner.md",
    "docs/owner.md:stream",
    "docs/control\u0001.md",
    "docs/trailing-space ",
  ];
  for (const invalidPath of invalidPaths) {
    const candidate = specification();
    candidate.ownerDocs = [invalidPath];
    await withFixture(async (root) => {
      const result = await run(root);
      assert.equal(result.outcome, "invalid-input");
      assert.equal(
        result.problem.code,
        invalidPath.includes("/./")
          ? "CONFIG_PATH_INVALID"
          : "EXECUTABLE_SPECIFICATION_PATH_NOT_PORTABLE",
      );
    }, { schemaVersion: 1, specifications: [candidate] });
  }
});

test("rejects selected workspace manifest aliases before reading them", async () => {
  await withFixture(async (root) => {
    const inspector = new capabilityModule.FilesystemExecutableSpecificationInspector({
      async discoverManifestPaths() {
        return ["package.json", "DOCS/WORKFLOW.MD"];
      },
    }, createJsonSchemaInspector, artifactFiles);
    await assert.rejects(
      capabilityModule.analyzeExecutableSpecifications(
        { consumerRoot: root, catalog: catalogOf(specification()) },
        inspector,
      ),
      ({ problem }) =>
        problem?.code === "EXECUTABLE_SPECIFICATION_MANIFEST_PATH_COLLISION",
    );
  });
});

test("rejects exact owner-manifest reuse and root package case aliases before reads", async () => {
  for (const manifestPath of ["docs/workflow.md", "Package.json"]) {
    await withFixture(async (root) => {
      const inspector = new capabilityModule.FilesystemExecutableSpecificationInspector({
        async discoverManifestPaths() {
          return ["package.json", manifestPath];
        },
      }, createJsonSchemaInspector, artifactFiles);
      await assert.rejects(
        capabilityModule.analyzeExecutableSpecifications(
          { consumerRoot: root, catalog: catalogOf(specification()) },
          inspector,
        ),
        ({ problem }) =>
          problem?.code === "EXECUTABLE_SPECIFICATION_MANIFEST_PATH_COLLISION",
      );
    });
  }
});

test("rejects non-ASCII selected workspace manifests before reading them", async () => {
  await withFixture(async (root) => {
    const inspector = new capabilityModule.FilesystemExecutableSpecificationInspector({
      async discoverManifestPaths() {
        return ["package.json", "packages/\u03a3/package.json"];
      },
    }, createJsonSchemaInspector, artifactFiles);
    await assert.rejects(
      capabilityModule.analyzeExecutableSpecifications(
        { consumerRoot: root, catalog: catalogOf(specification()) },
        inspector,
      ),
      ({ problem }) =>
        problem?.code === "EXECUTABLE_SPECIFICATION_MANIFEST_PATH_NOT_PORTABLE",
    );
  });
});

test("uses one workspace inventory snapshot for a multi-specification catalog", async () => {
  await withFixture(async (root) => {
    const second = deliverySpecification();
    const deliverySchema = { ...schema(), $id: "https://schemas.example.test/delivery/v1" };
    await write(root, second.ownerDocs[0], "# Delivery owner\n");
    await write(root, second.adrRefs[0], "# Delivery decision\n");
    await writeJson(root, second.schemaPaths[0], deliverySchema);
    await writeJson(root, second.documents[0].path, { id: "sent", enabled: true });
    await write(root, second.generatedTypes[0].outputPath, "export interface Delivery {}\n");
    let inventoryReads = 0;
    const inventoryReader = {
      async discoverManifestPaths() {
        inventoryReads += 1;
        return ["package.json"];
      },
    };
    const inspector = new capabilityModule.FilesystemExecutableSpecificationInspector(
      inventoryReader, createJsonSchemaInspector, artifactFiles,
    );
    const diagnostics = await capabilityModule.analyzeExecutableSpecifications(
      { consumerRoot: root, catalog: catalogOf(specification(), second) },
      inspector,
    );
    assert.deepEqual(diagnostics, []);
    assert.equal(inventoryReads, 1);
  });
});

test("fails closed on missing, reordered, or mismatched catalog observations", async () => {
  const first = specification();
  const second = deliverySpecification();
  const invalidObservations = [
    [],
    [{ id: second.id }, { id: first.id }],
    [{ id: "unexpected-contract" }, { id: second.id }],
  ];
  for (const observations of invalidObservations) {
    await assert.rejects(
      capabilityModule.analyzeExecutableSpecifications(
        { consumerRoot: "/not-used", catalog: catalogOf(first, second) },
        { async inspectCatalog() { return observations; } },
      ),
      ({ problem }) =>
        problem?.code === "EXECUTABLE_SPECIFICATION_OBSERVATION_INVALID",
    );
  }
});

test("enforces the shared aggregate byte budget at its exact boundary without recharging cached reads", async () => {
  await withFixture(async (root) => {
    const governedPaths = [
      "package.json",
      "docs/workflow.md",
      "docs/decisions/0001-workflow.md",
      "specifications/workflow.schema.json",
      "specifications/workflow.json",
      "src/generated/workflow.ts",
    ];
    const exactBytes = (
      await Promise.all(governedPaths.map((path) => readFile(join(root, path))))
    ).reduce((total, bytes) => total + bytes.byteLength, 0);
    const inventoryReader = {
      async discoverManifestPaths() {
        return ["package.json"];
      },
    };
    const catalog = catalogOf(specification());
    assert.deepEqual(
      await capabilityModule.analyzeExecutableSpecifications(
        { consumerRoot: root, catalog },
        new capabilityModule.FilesystemExecutableSpecificationInspector(
          inventoryReader, createJsonSchemaInspector, artifactFiles, exactBytes,
        ),
      ),
      [],
    );
    await assert.rejects(
      capabilityModule.analyzeExecutableSpecifications(
        { consumerRoot: root, catalog },
        new capabilityModule.FilesystemExecutableSpecificationInspector(
          inventoryReader, createJsonSchemaInspector, artifactFiles, exactBytes - 1,
        ),
      ),
      ({ problem }) =>
        problem?.code === "EXECUTABLE_SPECIFICATION_AGGREGATE_BYTES_EXCEEDED",
    );
  });
});

test("accepts the exact 4 MiB JSON catalog limit and rejects one byte more", async () => {
  await withFixture(async (root) => {
    const catalogPath = join(root, "architecture", "specifications.json");
    const source = `${JSON.stringify({ schemaVersion: 1, specifications: [specification()] })}\n`;
    const exactSource = source.padEnd(4 * 1024 * 1024, " ");
    await writeFile(catalogPath, exactSource, "utf8");
    assert.equal((await run(root)).outcome, "passed");

    await writeFile(catalogPath, `${exactSource} `, "utf8");
    const oversized = await run(root);
    assert.equal(oversized.problem.code, "EXECUTABLE_SPECIFICATION_CATALOG_INVALID");
  });
});

test("accepts exact 8 MiB artifacts and workspace manifests and rejects one byte more", async () => {
  await withFixture(async (root) => {
    const ownerPath = join(root, "docs", "workflow.md");
    await writeFile(ownerPath, "# owner\n".padEnd(8 * 1024 * 1024, " "), "utf8");
    assert.equal((await run(root)).outcome, "passed");
    await writeFile(ownerPath, "# owner\n".padEnd((8 * 1024 * 1024) + 1, " "), "utf8");
    const oversizedArtifact = await run(root);
    assert.equal(oversizedArtifact.outcome, "invalid-input");
    assert.equal(oversizedArtifact.problem.code, "EXECUTABLE_SPECIFICATION_ARTIFACT_INVALID");

    await write(root, "docs/workflow.md", "# owner\n");
    const manifestPath = join(root, "package.json");
    const manifest = JSON.stringify({
      name: "@example/specs",
      scripts: {
        "spec:typegen": "consumer-owned-type-generation",
        "spec:property": "consumer-owned-property-tests",
        "spec:mutation": "consumer-owned-mutation-tests",
      },
    });
    await writeFile(manifestPath, manifest.padEnd(8 * 1024 * 1024, " "), "utf8");
    assert.equal((await run(root)).outcome, "passed");
    await writeFile(manifestPath, manifest.padEnd((8 * 1024 * 1024) + 1, " "), "utf8");
    const oversizedManifest = await run(root);
    assert.equal(oversizedManifest.outcome, "invalid-input");
    assert.equal(oversizedManifest.problem.code, "EXECUTABLE_SPECIFICATION_ARTIFACT_INVALID");
  });
});

test("charges workspace manifests before parsing beyond the aggregate budget", async () => {
  await withFixture(async (root) => {
    const secondManifestPath = "packages/large/package.json";
    await writeJson(root, secondManifestPath, {
      name: "@example/large",
      description: "x".repeat(4096),
    });
    const manifestBytes = (
      await Promise.all(
        ["package.json", secondManifestPath].map((path) => readFile(join(root, path))),
      )
    ).reduce((total, bytes) => total + bytes.byteLength, 0);
    const reader = {
      async discoverManifestPaths() {
        return ["package.json", secondManifestPath];
      },
    };
    await assert.rejects(
      capabilityModule.analyzeExecutableSpecifications(
        { consumerRoot: root, catalog: catalogOf(specification()) },
        new capabilityModule.FilesystemExecutableSpecificationInspector(
          reader, createJsonSchemaInspector, artifactFiles,
          manifestBytes - 1,
        ),
      ),
      ({ problem }) =>
        problem?.code === "EXECUTABLE_SPECIFICATION_AGGREGATE_BYTES_EXCEEDED",
    );
  });
});

test("rejects an oversized workspace manifest set before reading package files", async () => {
  await withFixture(async (root) => {
    const reader = {
      async discoverManifestPaths() {
        return Array.from(
          { length: 1_025 },
          (_, index) => `packages/package-${index}/package.json`,
        );
      },
    };
    await assert.rejects(
      capabilityModule.analyzeExecutableSpecifications(
        { consumerRoot: root, catalog: catalogOf(specification()) },
        new capabilityModule.FilesystemExecutableSpecificationInspector(reader, createJsonSchemaInspector, artifactFiles),
      ),
      ({ problem }) =>
        problem?.code === "EXECUTABLE_SPECIFICATION_ARTIFACT_COUNT_EXCEEDED",
    );
  });
});

test("rejects duplicate XState axis identifiers", async () => {
  const invalid = specification({
    kind: "xstate",
    axes: ["lifecycle", "lifecycle"],
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
