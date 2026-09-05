import { createJsonSchemaInspector, executableArtifactFiles as artifactFiles } from "./support/capability-adapters.mjs";
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
const filesystem = await import(pathToFileURL(join(distRoot, "source-inventory/node.js")).href);

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

test("artifact file port preserves results and reads each cached identity once", async () => {
  await withRoot(async (root) => {
    const candidate = specification();
    await materialize(root, [candidate]);
    const calls = [];
    const files = {
      calls,
      async read(input) {
        this.calls.push(input);
        return new Uint8Array(await artifactFiles.read(input));
      },
    };
    const inspector = new capabilityModule.FilesystemExecutableSpecificationInspector(
      { async discoverManifestPaths() { return ["package.json"]; } }, createJsonSchemaInspector, files,
    );
    assert.deepEqual(await capabilityModule.analyzeExecutableSpecifications(
      { consumerRoot: root, catalog: catalogOf(candidate) }, inspector,
    ), []);
    assert.deepEqual(calls.map(({ candidate: path }) => path).toSorted(), [
      "package.json", ...candidate.ownerDocs, ...candidate.adrRefs, ...candidate.schemaPaths,
      ...candidate.documents.map(({ path }) => path), ...candidate.generatedTypes.map(({ outputPath }) => outputPath),
    ].map((path) => join(root, path)).toSorted());
    assert.ok(calls.every((call) => call.root === root && call.maxBytes === 8 * 1024 * 1024));
  });
});

for (const failure of ["escape", "symlink", "invalid", "changed", "unavailable"]) {
  test(`artifact file port preserves ${failure} diagnostics`, async () => {
    await withRoot(async (root) => {
      const files = { async read() { throw new filesystem.ContainedFileReadError(failure); } };
      const inspector = new capabilityModule.FilesystemExecutableSpecificationInspector(
        { async discoverManifestPaths() { return ["package.json"]; } }, createJsonSchemaInspector, files,
      );
      await assert.rejects(inspector.inspectCatalog({ consumerRoot: root, catalog: catalogOf(specification()) }),
        ({ problem }) => problem?.code === `EXECUTABLE_SPECIFICATION_ARTIFACT_${failure.toUpperCase()}` &&
          problem.phase === "executable-specification-inspection" && problem.retryable === false);
    });
  });
}

test("artifact file port preserves missing evidence without retrying the filesystem", async () => {
  await withRoot(async (root) => {
    const candidate = specification();
    await materialize(root, [candidate]);
    const files = { async read(input) {
      if (input.candidate === join(root, candidate.ownerDocs[0])) {
        throw new filesystem.ContainedFileReadError("missing");
      }
      return artifactFiles.read(input);
    } };
    const inspector = new capabilityModule.FilesystemExecutableSpecificationInspector(
      { async discoverManifestPaths() { return ["package.json"]; } }, createJsonSchemaInspector, files,
    );
    const observations = await inspector.inspectCatalog({ consumerRoot: root, catalog: catalogOf(candidate) });
    assert.deepEqual(observations[0].missingArtifactPaths, candidate.ownerDocs);
  });
});

test("artifact file port rejects oversized bytes before parsing a manifest", async () => {
  await withRoot(async (root) => {
    const files = { async read() { return new Uint8Array(8 * 1024 * 1024 + 1); } };
    const inspector = new capabilityModule.FilesystemExecutableSpecificationInspector(
      { async discoverManifestPaths() { return ["package.json"]; } }, createJsonSchemaInspector, files,
    );
    await assert.rejects(inspector.inspectCatalog({ consumerRoot: root, catalog: catalogOf(specification()) }),
      ({ problem }) => problem?.code === "EXECUTABLE_SPECIFICATION_ARTIFACT_INVALID");
  });
});

test("artifact file port propagates unexpected failures by identity", async () => {
  await withRoot(async (root) => {
    const failure = new Error("injected artifact failure");
    const files = { async read() { throw failure; } };
    const inspector = new capabilityModule.FilesystemExecutableSpecificationInspector(
      { async discoverManifestPaths() { return ["package.json"]; } }, createJsonSchemaInspector, files,
    );
    await assert.rejects(inspector.inspectCatalog({ consumerRoot: root, catalog: catalogOf(specification()) }),
      (actual) => actual === failure);
  });
});

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
    }, createJsonSchemaInspector, artifactFiles);
    const exact = await capabilityModule.analyzeExecutableSpecifications(
      { consumerRoot: root, catalog: catalogOf(candidate) },
      exactInspector,
    );
    assert.deepEqual(exact, []);

    const oversizedInspector = new capabilityModule.FilesystemExecutableSpecificationInspector({
      async discoverManifestPaths() {
        return ["package.json", "packages/unread/package.json"];
      },
    }, createJsonSchemaInspector, artifactFiles);
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
      { async discoverManifestPaths() { return ["package.json"]; } }, createJsonSchemaInspector, artifactFiles,
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
      artifactFiles,
    );
    await assert.rejects(
      inspector.inspectCatalog({ consumerRoot: root, catalog: catalogOf(spec) }),
      (error) => error === failure,
    );
    assert.equal(calls, 1);
  });
});
