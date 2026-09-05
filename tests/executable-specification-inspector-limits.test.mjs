import { createJsonSchemaInspector } from "./support/capability-adapters.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

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

async function write(root, path, source) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source, "utf8");
}

async function writeJson(root, path, value) {
  await write(root, path, `${JSON.stringify(value)}\n`);
}

function specification(id = "workflow") {
  const schemaId = `https://schemas.example.test/${id}/v1`;
  return {
    id,
    ownerDocs: ["docs/shared-owner.md"],
    adrRefs: ["docs/decisions/shared.md"],
    schemaPaths: [`specifications/${id}.schema.json`],
    documents: [{ path: `specifications/${id}.json`, schemaId }],
    generatedTypes: [{ schemaId, outputPath: `src/generated/${id}.ts` }],
    gateBindings: {
      typeGeneration: { packageName: "@example/specs", script: "spec:typegen" },
      property: { packageName: "@example/specs", script: "spec:property" },
      mutation: { packageName: "@example/specs", script: "spec:mutation" },
    },
    stateModel: { kind: "none" },
  };
}

function catalogOf(...specifications) {
  return {
    schemaVersion: 1,
    configPath: "quality.yaml",
    catalogPath: "architecture/specifications.json",
    specifications,
  };
}

async function materialize(root, specs) {
  await writeJson(root, "package.json", {
    name: "@example/specs",
    scripts: {
      "spec:typegen": "typegen",
      "spec:property": "property",
      "spec:mutation": "mutation",
    },
  });
  await write(root, "docs/shared-owner.md", "# Owner\n");
  await write(root, "docs/decisions/shared.md", "# Decision\n");
  for (const spec of specs) {
    await writeJson(root, spec.schemaPaths[0], {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: spec.documents[0].schemaId,
      type: "object",
    });
    await writeJson(root, spec.documents[0].path, { valid: true });
    await write(root, spec.generatedTypes[0].outputPath, "export {};\n");
  }
}

async function withRoot(callback) {
  const root = await mkdtemp(join(tmpdir(), "foundation-executable-inspector-limits-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("real inspector accepts exactly 1024 combined identities and rejects 1025 before reads", async () => {
  await withRoot(async (root) => {
    const candidate = specification();
    candidate.ownerDocs = Array.from({ length: 1_019 }, (_, index) => `docs/owner-${index}.md`);
    await materialize(root, [candidate]);
    for (const ownerPath of candidate.ownerDocs) {
      await write(root, ownerPath, "# Owner\n");
    }
    const exactInspector = new capabilityModule.FilesystemExecutableSpecificationInspector({
      async discoverManifestPaths() { return ["package.json"]; },
    }, createJsonSchemaInspector);
    const exact = await capabilityModule.analyzeExecutableSpecifications(
      { consumerRoot: root, catalog: catalogOf(candidate) },
      exactInspector,
    );
    assert.deepEqual(exact, []);

    const oversizedInspector = new capabilityModule.FilesystemExecutableSpecificationInspector({
      async discoverManifestPaths() {
        return ["package.json", "packages/unread/package.json"];
      },
    }, createJsonSchemaInspector);
    await assert.rejects(
      oversizedInspector.inspectCatalog({
        consumerRoot: "/definitely-not-readable",
        catalog: catalogOf(candidate),
      }),
      ({ problem }) => problem?.code === "EXECUTABLE_SPECIFICATION_ARTIFACT_COUNT_EXCEEDED",
    );
  });
});

test("shared owner and ADR evidence are read and charged once across passing specs", async () => {
  await withRoot(async (root) => {
    const specs = [specification("workflow"), specification("delivery")];
    await materialize(root, specs);
    const uniquePaths = [
      "package.json",
      "docs/shared-owner.md",
      "docs/decisions/shared.md",
      ...specs.flatMap((spec) => [
        spec.schemaPaths[0],
        spec.documents[0].path,
        spec.generatedTypes[0].outputPath,
      ]),
    ];
    const exactBytes = (
      await Promise.all(uniquePaths.map((path) => readFile(join(root, path))))
    ).reduce((total, bytes) => total + bytes.byteLength, 0);
    const inspector = new capabilityModule.FilesystemExecutableSpecificationInspector(
      { async discoverManifestPaths() { return ["package.json"]; } }, createJsonSchemaInspector,
      exactBytes,
    );
    assert.deepEqual(
      await capabilityModule.analyzeExecutableSpecifications(
        { consumerRoot: root, catalog: catalogOf(...specs) },
        inspector,
      ),
      [],
    );
  });
});

test("schema inspection uses a caller-selected factory sharing one bounded artifact session", async () => {
  await withRoot(async (root) => {
    const spec = specification();
    await materialize(root, [spec]);
    const failure = new Error("selected schema inspector");
    let calls = 0;
    const inspector = new capabilityModule.FilesystemExecutableSpecificationInspector(
      { async discoverManifestPaths() { return ["package.json"]; } },
      (readArtifact) => ({
        async inspect(input) {
          calls += 1;
          assert.equal(input.consumerRoot, root);
          const first = await readArtifact(spec.schemaPaths[0]);
          await write(root, spec.schemaPaths[0], "changed after observation");
          assert.deepEqual(await readArtifact(spec.schemaPaths[0]), first);
          throw failure;
        },
      }),
    );
    await assert.rejects(
      inspector.inspectCatalog({ consumerRoot: root, catalog: catalogOf(spec) }),
      (error) => error === failure,
    );
    assert.equal(calls, 1);
  });
});
