import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml, stringify } from "yaml";

import { MAXIMUM_CENTRAL_AUTHORITY_JSON_BYTES } from "../scripts/bounded-central-authority-response.mjs";
import {
  assertCanonicalManagedState,
  observeCentralCohortAuthority,
  assertNpmLockCoordinates,
  assertPnpmLockCoordinates,
  assertQualificationReceiptDigest,
} from "../scripts/public-managed-registry-canary.mjs";
import {
  assertCanaryReceiptDigest,
  assertPortableCoreClosure,
  assertRegistryObservations,
  assertSafeTarballInventory,
  assertTarballEntryTypes,
  createCanaryAuthority,
  finalizeCanaryReceipt,
  hostilePolicyMatrix,
  parseCanaryInputs,
  publicationClosureDecision,
} from "../scripts/public-managed-registry-canary-policy.mjs";

const commit = "a".repeat(40);
const authorityRevision = "b".repeat(40);
const sha256 = (character) => `sha256:${character.repeat(64)}`;
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const integrity = (byte) => `sha512-${Buffer.alloc(64, byte).toString("base64")}`;
const descriptors = [
  ["repositoryMutation", "@agent-teams/repository-mutation", false],
  ["documentAuthoring", "@agent-teams/document-authoring", false],
  ["docsProtocol", "@agent-teams/docs-protocol", true],
  ["docsProtocolAgentTeams", "@agent-teams/docs-protocol-agent-teams", true],
  ["engineeringFoundation", "@agent-teams/engineering-foundation", true],
];
const cohort = {
  schemaVersion: 2,
  cohortId: "docs-v2-canary",
  channel: "stable",
  recordDigest: sha256("1"),
  qualificationEventDigest: sha256("2"),
  eligibleAfter: "2026-09-04T12:00:00Z",
  upgradeFrom: ["docs-v1"],
  rollbackTo: ["docs-v1"],
  packages: Object.fromEntries(descriptors.map(([key], index) => [key, {
    version: `1.0.${index}`,
    integrity: integrity(index + 1),
  }])),
  workflow: {
    repository: "agent-teams-ai/.github",
    path: ".github/workflows/docs-protocol-check.yml",
    revision: "3".repeat(40),
    blobSha: "4".repeat(40),
  },
  assets: {
    skillDigest: sha256("5"), callerWorkflowDigest: sha256("6"),
    assetCatalogDigest: sha256("7"), transitionCatalogDigest: sha256("8"),
  },
  schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 },
  runtime: { node: ">=24.18.0 <25", pnpm: ">=11.17.0 <12", runtimeClosureDigest: sha256("9") },
};
const inputs = parseCanaryInputs({ authorityRevision, cohortId: cohort.cohortId, expectedCommit: commit });
const projected = { repository: "agent-teams-ai/.github", path: "governance/docs-qualified-cohorts.json", revision: authorityRevision, cohort };
const authority = createCanaryAuthority(projected, inputs);
const repository = { provider: "github", id: "1316243988", nameWithOwner: "agent-teams-ai/engineering-foundation" };

function canonicalJson(value) {
  if (Array.isArray(value)) { return `[${value.map(canonicalJson).join(",")}]`; }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).toSorted(([left], [right]) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function registryFixture(records = [{ cohort_id: cohort.cohortId, cohort_generation: 2 }]) {
  return {
    schema_version: 1,
    cohorts: records,
    events: [{ sequence: 1, cohort_id: cohort.cohortId, state: "QUALIFIED", event_digest: cohort.qualificationEventDigest }],
  };
}

function strictFixtureProjector(input) {
  const matches = input.registry.cohorts.filter(({ cohort_id: id }) => id === input.cohortId);
  if (matches.length !== 1) { throw new Error("Cohort must occur exactly once"); }
  if (matches[0].cohort_generation !== 2) { throw new Error("wrong Cohort generation"); }
  const events = input.registry.events.filter(({ cohort_id: id }) => id === input.cohortId);
  const qualified = events.filter(({ state }) => state === "QUALIFIED");
  if (qualified.length !== 1 || !["QUALIFIED", "CANARY"].includes(events.at(-1)?.state)) {
    throw new Error("Cohort is not eligible for canary");
  }
  assert.deepEqual(input.repository, repository);
  return projected;
}

function centralFetcher({ branchProtected = true, branchSha = authorityRevision, registry = registryFixture() } = {}) {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["schema_version", "cohorts", "events"],
    properties: {
      schema_version: { const: 1 }, cohorts: { type: "array" }, events: { type: "array" },
    },
  };
  return async (url) => {
    const value = String(url).endsWith("/branches/main")
      ? { protected: branchProtected, commit: { sha: branchSha } }
      : String(url).endsWith(".schema.json") ? schema : registry;
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("workflow inputs are minimal non-circular authority references", () => {
  assert.deepEqual(inputs, { authorityRevision, cohortId: cohort.cohortId, expectedCommit: commit });
  assert.throws(() => parseCanaryInputs({ ...inputs, authorityRevision: "0".repeat(40) }), /nonzero/u);
  assert.throws(() => parseCanaryInputs({ ...inputs, cohortId: "../escape" }), /cohort ID/u);
  assert.deepEqual(authority.roots.map(({ name }) => name), descriptors.filter(([, , direct]) => direct).map(([, name]) => name));
});

test("central authority must be current protected main and binds exact registry path/revision", async () => {
  const observed = await observeCentralCohortAuthority(
    { inputs, repository },
    { fetcher: centralFetcher(), projectAuthority: strictFixtureProjector },
  );
  assert.deepEqual(observed.central, {
    repository: "agent-teams-ai/.github",
    path: "governance/docs-qualified-cohorts.json",
    schemaPath: "governance/docs-qualified-cohorts.schema.json",
    revision: authorityRevision,
  });
  await assert.rejects(
    observeCentralCohortAuthority({ inputs, repository }, {
      fetcher: centralFetcher({ branchProtected: false }), projectAuthority: strictFixtureProjector,
    }),
    /current protected-main SHA/u,
  );
  await assert.rejects(
    observeCentralCohortAuthority({ inputs, repository }, {
      fetcher: centralFetcher({ branchSha: "c".repeat(40) }), projectAuthority: strictFixtureProjector,
    }),
    /current protected-main SHA/u,
  );
});

test("central selection rejects missing, duplicate, wrong-generation, and non-canary Cohorts", async () => {
  for (const registry of [
    registryFixture([]),
    registryFixture([{ cohort_id: cohort.cohortId, cohort_generation: 2 }, { cohort_id: cohort.cohortId, cohort_generation: 2 }]),
    registryFixture([{ cohort_id: cohort.cohortId, cohort_generation: 1 }]),
    { ...registryFixture(), events: [{ sequence: 1, cohort_id: cohort.cohortId, state: "PUBLISHED_UNQUALIFIED", event_digest: sha256("a") }] },
  ]) {
    await assert.rejects(
      observeCentralCohortAuthority({ inputs, repository }, {
        fetcher: centralFetcher({ registry }), projectAuthority: strictFixtureProjector,
      }),
    );
  }
});

test("central authority bytes reject oversized and duplicate-key JSON before projection", async () => {
  const hostileBodies = [
    `${" ".repeat(MAXIMUM_CENTRAL_AUTHORITY_JSON_BYTES)}{}`,
    `{"schema_version":1,"schema_version":2,"cohorts":[],"events":[]}`,
    `{"schema_version":1,"cohorts":[],"events":[],"nested":{"key":1,"key":2}}`,
  ];
  for (const body of hostileBodies) {
    let projectionCalls = 0;
    const hostileFetcher = async (url) => {
      const value = String(url);
      if (value.endsWith("/branches/main")) {
        return new Response(JSON.stringify({ protected: true, commit: { sha: authorityRevision } }));
      }
      if (value.endsWith("docs-qualified-cohorts.json")) {
        return new Response(body, { headers: { "content-type": "application/json" } });
      }
      return centralFetcher()(url);
    };
    await assert.rejects(
      observeCentralCohortAuthority({ inputs, repository }, {
        fetcher: hostileFetcher,
        projectAuthority: async () => {
          projectionCalls += 1;
          return projected;
        },
      }),
      /byte-size limit|duplicate-free/u,
    );
    assert.equal(projectionCalls, 0);
  }
});

test("live registry observations are independent and fail on authority mismatch", () => {
  const observations = Object.fromEntries(authority.coordinates.map(({ name, version, integrity: sri }) => [name, {
    version, integrity: sri, latest: version,
  }]));
  assert.equal(assertRegistryObservations(authority, observations), observations);
  const drift = structuredClone(observations);
  drift["@agent-teams/document-authoring"].integrity = integrity(20);
  assert.throws(() => assertRegistryObservations(authority, drift), /live registry identity/u);
});

test("npm and isolated pnpm lock evidence proves five coordinates and excludes MCP", () => {
  const npmPackages = {};
  const pnpmPackages = {};
  for (const coordinate of authority.coordinates) {
    const base = coordinate.direct ? "" : "node_modules/@agent-teams/docs-protocol/";
    npmPackages[`${base}node_modules/${coordinate.name}`] = {
      version: coordinate.version, integrity: coordinate.integrity,
    };
    pnpmPackages[`${coordinate.name}@${coordinate.version}`] = {
      resolution: { integrity: coordinate.integrity },
    };
  }
  assert.doesNotThrow(() => assertNpmLockCoordinates(Buffer.from(JSON.stringify({ packages: npmPackages })), authority));
  assert.doesNotThrow(() => assertPnpmLockCoordinates(Buffer.from(stringify({
    lockfileVersion: "9.0", packages: pnpmPackages, snapshots: {}, importers: { ".": {} },
  })), authority));

  npmPackages["node_modules/@agent-teams/docs-protocol-mcp"] = { version: "1.0.0", integrity: integrity(30) };
  assert.throws(() => assertNpmLockCoordinates(Buffer.from(JSON.stringify({ packages: npmPackages })), authority), /MCP/u);
  pnpmPackages["@agent-teams/docs-protocol-mcp@1.0.0"] = { resolution: { integrity: integrity(30) } };
  assert.throws(() => assertPnpmLockCoordinates(Buffer.from(stringify({ packages: pnpmPackages })), authority), /MCP/u);
});

test("partial publication and missing adapter fail closed", () => {
  const observations = Object.fromEntries(authority.coordinates.map(({ name, version }) => [name, { version }]));
  assert.equal(publicationClosureDecision(authority, observations).status, "ready");
  delete observations["@agent-teams/docs-protocol-agent-teams"];
  assert.equal(publicationClosureDecision(authority, observations).status, "rejected");
});

test("tarball and portable boundaries reject aliases, links, and managed authority", () => {
  assert.deepEqual(assertSafeTarballInventory(["package/package.json", "package/dist/index.js"], "fixture"), [
    "package/package.json", "package/dist/index.js",
  ]);
  for (const entries of [
    ["package/../escape"], ["/package/index.js"], ["package\\index.js"],
    ["package/cafe\u0301.js"], ["package/File.js", "package/file.js"],
  ]) { assert.throws(() => assertSafeTarballInventory(entries, "fixture"), /rejected/u); }
  assert.throws(() => assertTarballEntryTypes("lrwxr-xr-x 0/0 0 package/link -> target\n", "fixture"), /link/u);
  assert.throws(() => assertPortableCoreClosure({ dependencies: {}, entries: ["package/dist/runDocsProtocolQualificationV3.js"] }), /managed authority/u);
});

test("hostile matrix makes no managed interruption execution claim", () => {
  const matrix = hostilePolicyMatrix(authority);
  assert.equal(matrix.length, 8);
  assert.ok(matrix.every(({ mode, outcome }) => mode === "deterministic-policy" && outcome === "rejected"));
  assert.equal(JSON.stringify(matrix).includes("interruption"), false);
});

test("nested qualification and managed-state digests are independently canonical", () => {
  const qualificationBody = {
    schemaVersion: 3, cohortAdmissible: true, profileSchemaVersion: 3,
    cohort: { schemaVersion: 2, cohortId: cohort.cohortId, recordDigest: cohort.recordDigest, qualificationEventDigest: cohort.qualificationEventDigest },
    packages: authority.coordinates.map(({ key, name, version, integrity: sri }) => ({ key, name, version, integrity: sri })),
    schemas: cohort.schemas, runtime: { runtimeClosureDigest: cohort.runtime.runtimeClosureDigest },
    checks: ["profile-v3", "cohort-v2", "five-package-closure", "exact-package-versions", "exact-package-integrities", "schema-bindings-3-2-1", "runtime-closure-digest"],
  };
  const qualificationReceipt = { ...qualificationBody, receiptDigest: digest(canonicalJson(qualificationBody)) };
  assert.doesNotThrow(() => assertQualificationReceiptDigest(qualificationReceipt));
  assert.throws(() => assertQualificationReceiptDigest({ ...qualificationReceipt, cohortAdmissible: false }), /receipt digest/u);

  const stateBody = { schemaVersion: 2 };
  const stateDigest = digest(canonicalJson({ domain: "agent-teams.docs-protocol.managed-state/v2", body: stateBody }));
  const serialization = `${canonicalJson({ ...stateBody, stateDigest })}\n`;
  assert.equal(assertCanonicalManagedState(serialization).stateDigest, stateDigest);
  assert.throws(() => assertCanonicalManagedState(serialization.slice(0, -1)), /newline/u);
});

test("canonical canary receipt validates central binding and exact unique package provenance", async () => {
  const qualificationBody = {
    schemaVersion: 3, cohortAdmissible: true, profileSchemaVersion: 3,
    cohort: { schemaVersion: 2, cohortId: cohort.cohortId, recordDigest: cohort.recordDigest, qualificationEventDigest: cohort.qualificationEventDigest },
    packages: authority.coordinates.map(({ key, name, version, integrity: sri }) => ({ key, name, version, integrity: sri })),
    schemas: cohort.schemas, runtime: { runtimeClosureDigest: cohort.runtime.runtimeClosureDigest },
    checks: ["profile-v3", "cohort-v2", "five-package-closure", "exact-package-versions", "exact-package-integrities", "schema-bindings-3-2-1", "runtime-closure-digest"],
  };
  const qualificationReceipt = { ...qualificationBody, receiptDigest: digest(canonicalJson(qualificationBody)) };
  const stateBody = { schemaVersion: 2 };
  const stateDigest = digest(canonicalJson({ domain: "agent-teams.docs-protocol.managed-state/v2", body: stateBody }));
  const receipt = finalizeCanaryReceipt({
    schemaVersion: 1,
    run: { repository: "agent-teams-ai/engineering-foundation", runId: 1, runAttempt: 1, createdAt: "2026-09-04T12:00:00.000Z" },
    authority: { central: authority.central, cohort, expectedCommit: commit, registry: authority.registry },
    packages: authority.coordinates.map(({ name, version, integrity: sri }) => ({ name, version, integrity: sri, latest: version, provenanceCommit: commit, provenanceAncestorOfExpectedCommit: true, tarballEntries: 3 })),
    installs: ["npm", "pnpm"].map((manager) => ({ manager, lockfileDigest: sha256("b"), rootCount: 3, fivePackageLockValidated: true, mcpAbsent: true })),
    portableNegative: { adapterAbsent: true, forbiddenTermsAbsent: true, lockfileDigest: sha256("c") },
    managedQualification: {
      actualRuntimeClosureDigest: cohort.runtime.runtimeClosureDigest,
      managedState: { schemaVersion: 2, schemaValidated: true, serialization: `${canonicalJson({ ...stateBody, stateDigest })}\n`, stateDigest },
      qualificationReceipt,
      schemaEvidence: { consumerIntegration: 3, managedState: 2, docsProtocol: 1, validated: true },
    },
    hostile: [...hostilePolicyMatrix(authority),
      { id: "tarball-inventory", mode: "installed-execution", outcome: "passed" },
      { id: "portable-managed-denylist", mode: "installed-execution", outcome: "passed" },
      { id: "qualification-v3", mode: "installed-execution", outcome: "passed" },
      { id: "managed-state-v2-schema", mode: "installed-execution", outcome: "passed" }],
  });
  const schema = JSON.parse(await readFile(new URL("../architecture/foundation/schemas/public-managed-registry-canary-receipt-v1.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
  assert.doesNotThrow(() => assertCanaryReceiptDigest(receipt));
  const duplicate = structuredClone(receipt);
  duplicate.packages[1].name = duplicate.packages[0].name;
  assert.equal(validate(duplicate), false);
});

test("workflow is manual and capture plus digest precede the earliest installed import", async () => {
  const source = await readFile(new URL("../.github/workflows/public-managed-registry-canary.yml", import.meta.url), "utf8");
  const runnerSource = await readFile(new URL("../scripts/public-managed-registry-canary.mjs", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).toSorted(), ["authority_revision", "cohort_id", "expected_commit"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs.qualify.steps[0].with["fetch-depth"], 0);
  assert.equal(JSON.stringify(workflow).includes("secrets."), false);
  assert.doesNotMatch(source, /npm\s+(?:publish|unpublish|deprecate|dist-tag)|pnpm\s+publish/u);
  assert.match(source, /pnpm build/u);
  const capture = runnerSource.indexOf("const lockfile = await readFile");
  const copy = runnerSource.indexOf("const lockfileBytes = Buffer.from(lockfile)", capture);
  const digestCapture = runnerSource.indexOf("const lockfileDigest = sha256(lockfileBytes)", copy);
  const installedImports = [
    runnerSource.indexOf("await import(${JSON.stringify(coordinate.name)})"),
    runnerSource.indexOf("await import('@agent-teams/docs-protocol-agent-teams')"),
    runnerSource.indexOf("await import('@agent-teams/docs-protocol-agent-teams/qualification')"),
  ].filter((index) => index >= 0);
  const earliestInstalledImport = Math.min(...installedImports);
  assert.ok(capture >= 0 && copy > capture && digestCapture > copy && earliestInstalledImport > digestCapture);
  assert.match(runnerSource, /lockfileBytes: exactLockfileBytes\(\)/u);
  assert.doesNotMatch(
    runnerSource.slice(earliestInstalledImport - 300, earliestInstalledImport),
    /readFile\('pnpm-lock\.yaml'\)/u,
  );
  assert.match(runnerSource, /GITHUB_REPOSITORY_ID/u);
});
