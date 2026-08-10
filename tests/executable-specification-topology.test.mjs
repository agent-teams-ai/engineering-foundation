import assert from "node:assert/strict";
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

function specification(id = "workflow-contract") {
  return {
    id,
    ownerDocs: [`docs/${id}.md`],
    adrRefs: [`docs/decisions/${id}.md`],
    schemaPaths: [`specifications/${id}.schema.json`],
    documents: [{
      path: `specifications/${id}.json`,
      schemaId: `https://schemas.example.test/${id}/v1`,
    }],
    generatedTypes: [{
      schemaId: `https://schemas.example.test/${id}/v1`,
      outputPath: `src/generated/${id}.ts`,
    }],
    gateBindings: {
      typeGeneration: { packageName: "@example/specs", script: `${id}:typegen` },
      property: { packageName: "@example/specs", script: `${id}:property` },
      mutation: { packageName: "@example/specs", script: `${id}:mutation` },
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

test("accepts 255-character segments and rejects 256 before inspection", async () => {
  const accepted = specification();
  accepted.ownerDocs = [`docs/${"a".repeat(255)}`];
  let acceptedInspections = 0;
  await assert.rejects(
    capabilityModule.analyzeExecutableSpecifications(
      { consumerRoot: "/not-used", catalog: catalogOf(accepted) },
      {
        async inspectCatalog() {
          acceptedInspections += 1;
          throw new Error("accepted segment reached inspection");
        },
      },
    ),
    /accepted segment reached inspection/u,
  );
  assert.equal(acceptedInspections, 1);

  const rejected = specification();
  rejected.ownerDocs = [`docs/${"a".repeat(256)}`];
  let rejectedInspections = 0;
  const diagnostics = await capabilityModule.analyzeExecutableSpecifications(
    { consumerRoot: "/not-used", catalog: catalogOf(rejected) },
    {
      async inspectCatalog() {
        rejectedInspections += 1;
        return [];
      },
    },
  );
  assert.equal(rejectedInspections, 0);
  assert.ok(
    diagnostics.some(
      ({ ruleId }) => ruleId === "quality.executable-specifications.path-collision",
    ),
  );
});

test("rejects exact cross-role path reuse but permits shared owner evidence", async () => {
  const collisionCases = [
    () => ({ ...specification(), ownerDocs: ["package.json"] }),
    () => ({ ...specification(), adrRefs: ["quality.yaml"] }),
    () => {
      const candidate = specification();
      candidate.ownerDocs = [candidate.schemaPaths[0]];
      return candidate;
    },
    () => {
      const candidate = specification();
      candidate.ownerDocs = [candidate.adrRefs[0]];
      return candidate;
    },
    () => {
      const candidate = specification();
      candidate.generatedTypes[0].outputPath = candidate.ownerDocs[0];
      return candidate;
    },
  ];
  for (const createCandidate of collisionCases) {
    let inspections = 0;
    const diagnostics = await capabilityModule.analyzeExecutableSpecifications(
      { consumerRoot: "/not-used", catalog: catalogOf(createCandidate()) },
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

  const first = specification();
  const second = specification("delivery-contract");
  second.ownerDocs = first.ownerDocs;
  let inspections = 0;
  await capabilityModule.analyzeExecutableSpecifications(
    { consumerRoot: "/not-used", catalog: catalogOf(first, second) },
    {
      async inspectCatalog({ catalog }) {
        inspections += 1;
        return catalog.specifications.map((entry) => ({
          id: entry.id,
          jsonSchemas: {
            schemaIds: entry.documents.map(({ schemaId }) => schemaId),
            fixtureResults: [],
          },
          missingArtifactPaths: [],
          gates: Object.fromEntries(
            Object.entries(entry.gateBindings).map(([role, binding]) => [
              role,
              { ...binding, packageExists: true, scriptExists: true },
            ]),
          ),
          artifactDigest: `sha256:${"0".repeat(64)}`,
        }));
      },
    },
  );
  assert.equal(inspections, 1);
});

test("accepts exactly 1024 unique artifacts and rejects the next one before inspection", async () => {
  for (const artifactCount of [1_024, 1_025]) {
    const candidate = specification();
    candidate.ownerDocs = Array.from(
      { length: artifactCount - 4 },
      (_, index) => `docs/owner-${index}.md`,
    );
    let inspections = 0;
    const observations = await capabilityModule.analyzeExecutableSpecifications(
      { consumerRoot: "/not-used", catalog: catalogOf(candidate) },
      {
        async inspectCatalog() {
          inspections += 1;
          return [{
            id: candidate.id,
            jsonSchemas: { schemaIds: [candidate.documents[0].schemaId], fixtureResults: [] },
            missingArtifactPaths: [],
            gates: {},
            artifactDigest: `sha256:${"0".repeat(64)}`,
          }];
        },
      },
    ).catch((error) => error);
    if (artifactCount === 1_024) {
      assert.equal(inspections, 1);
      assert.ok(Array.isArray(observations));
    } else {
      assert.equal(inspections, 0);
      assert.equal(
        observations.problem?.code,
        "EXECUTABLE_SPECIFICATION_ARTIFACT_COUNT_EXCEEDED",
      );
    }
  }
});
