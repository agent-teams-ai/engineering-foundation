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
import { assertSupportingMcpNpmLockCoordinates } from "../scripts/public-managed-registry-canary-mcp.mjs";
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
  SUPPORTING_MCP_PACKAGE,
  supportingMcpCoordinate,
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
const cohortV2DependencyEdges = [
  ["@agent-teams/document-authoring", "@agent-teams/repository-mutation"],
  ["@agent-teams/docs-protocol", "@agent-teams/document-authoring"],
  ["@agent-teams/docs-protocol", "@agent-teams/repository-mutation"],
  ["@agent-teams/docs-protocol-agent-teams", "@agent-teams/docs-protocol"],
  ["@agent-teams/docs-protocol-agent-teams", "@agent-teams/repository-mutation"],
  ["@agent-teams/engineering-foundation", "@agent-teams/document-authoring"],
  ["@agent-teams/engineering-foundation", "@agent-teams/repository-mutation"],
];
const cohortV2Schemas = {
  consumer_integration: 3,
  managed_state: 2,
  docs_protocol: 1,
  qualification_receipt: 3,
  foundation_plan: 1,
  foundation_journal: 1,
  foundation_receipt: 1,
  foundation_envelope: 5,
};
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
const supportingMcp = {
  ...SUPPORTING_MCP_PACKAGE,
  integrity: integrity(40),
};
const repository = { provider: "github", id: "1316243988", nameWithOwner: "agent-teams-ai/engineering-foundation" };

function currentPackageAuthority([key, name, direct], index) {
  const version = cohort.packages[key].version;
  const workflowRunId = 123;
  return {
    name,
    role: direct ? "direct" : "transitive",
    ...cohort.packages[key],
    registry: "https://registry.npmjs.org/",
    published_at: "2026-09-03T00:00:00Z",
    provenance: {
      source_repository: "agent-teams-ai/engineering-foundation",
      source_repository_id: 1316243988,
      source_workflow: ".github/workflows/release.yml",
      source_commit: `${index + 1}`.repeat(40),
      workflow_run_id: workflowRunId,
      workflow_run_attempt: 1,
      registry_attestation_url: `https://registry.npmjs.org/-/npm/v1/attestations/${
        name.replaceAll("/", "%2f")
      }@${version}`,
      workflow_run_url: `https://github.com/agent-teams-ai/engineering-foundation/actions/runs/${workflowRunId}`,
      signature_verified: true,
    },
  };
}

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
  assert.equal(authority.coordinates.length, 5);
  assert.equal(authority.coordinates.some(({ name }) => name === SUPPORTING_MCP_PACKAGE.name), false);
});

test("supporting MCP precondition has one fixed exact public coordinate", () => {
  const packument = {
    "dist-tags": { latest: SUPPORTING_MCP_PACKAGE.version },
    versions: {
      [SUPPORTING_MCP_PACKAGE.version]: {
        ...SUPPORTING_MCP_PACKAGE,
        dist: { integrity: supportingMcp.integrity },
      },
    },
  };
  assert.deepEqual(supportingMcpCoordinate(packument), supportingMcp);
  const previous = {
    ...SUPPORTING_MCP_PACKAGE, version: "0.2.0", dist: { integrity: supportingMcp.integrity },
  };
  assert.throws(
    () => supportingMcpCoordinate({
      "dist-tags": { latest: previous.version },
      versions: { [previous.version]: previous },
    }),
    /exact latest/u,
  );
  assert.throws(
    () => supportingMcpCoordinate({ ...packument, "dist-tags": { latest: "0.1.1" } }),
    /exact latest/u,
  );
  const drift = structuredClone(packument);
  drift.versions[SUPPORTING_MCP_PACKAGE.version].dist.integrity = "sha512-not-canonical";
  assert.throws(() => supportingMcpCoordinate(drift), /canonical sha512 SRI/u);
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

test("central authority uses the production generation-2 projector", async () => {
  const registry = {
    schema_version: 1,
    cohorts: [{
      cohort_generation: 2,
      cohort_id: cohort.cohortId,
      channel: cohort.channel,
      record_digest: cohort.recordDigest,
      eligible_after: cohort.eligibleAfter,
      upgrade_from: cohort.upgradeFrom,
      rollback_to: cohort.rollbackTo,
      evidence_references: ["test:public-managed-registry-canary"],
      packages: descriptors.map(currentPackageAuthority),
      dependency_edges: cohortV2DependencyEdges.map(([from, to]) => ({ from, to })),
      reusable_workflow: {
        repository: cohort.workflow.repository, repository_id: 1316243981,
        path: cohort.workflow.path,
        revision: cohort.workflow.revision, blob_sha: cohort.workflow.blobSha,
      },
      assets: {
        skill: { package: descriptors[3][1], path: "skills/docs/SKILL.md", digest: cohort.assets.skillDigest },
        caller_workflow: {
          package: descriptors[3][1], path: "assets/docs-protocol.yml", digest: sha256("a"),
          rendered_digest: cohort.assets.callerWorkflowDigest,
        },
        asset_catalog: {
          package: descriptors[3][1], path: "assets/catalog.json",
          digest: cohort.assets.assetCatalogDigest,
        },
        transition_catalog: {
          package: descriptors[3][1], path: "assets/transition-catalog.json",
          digest: cohort.assets.transitionCatalogDigest,
        },
      },
      schemas: cohortV2Schemas,
      runtime: {
        node: cohort.runtime.node, pnpm: cohort.runtime.pnpm,
        apply_platforms: ["linux", "macos"],
        check_plan_platforms: ["linux", "macos", "windows"],
      },
      runtime_closure: {
        schema_version: 2, domain: "agent-teams.docs-runtime-closure/v2",
        package_manager: "pnpm@11.20.0", lockfile_version: "9.0", package_count: 5,
        projection_path: `governance/docs-runtime-closures/${
          cohort.runtime.runtimeClosureDigest.replace(":", "-")
        }.json`,
        digest: cohort.runtime.runtimeClosureDigest,
      },
      canary_repositories: [{
        repository_id: Number(repository.id), repository: repository.nameWithOwner,
      }],
    }],
    events: [{
      sequence: 1, cohort_id: cohort.cohortId, state: "QUALIFIED",
      effective_at: cohort.eligibleAfter,
      support_until: null,
      evidence_references: ["test:public-managed-registry-canary-qualified"],
      canary_evidence: [],
      previous_event_digest: null,
      event_digest: cohort.qualificationEventDigest,
    }],
  };
  const { record_digest: _recordDigest, ...recordBody } = registry.cohorts[0];
  registry.cohorts[0].record_digest = digest(canonicalJson({
    domain: "agent-teams.docs-qualified-cohort/v2", body: recordBody,
  }));
  const { event_digest: _eventDigest, ...eventBody } = registry.events[0];
  registry.events[0].event_digest = digest(canonicalJson({
    domain: "agent-teams.docs-qualified-cohort-event/v1", body: eventBody,
  }));
  const observed = await observeCentralCohortAuthority(
    { inputs, repository },
    { fetcher: centralFetcher({ registry }) },
  );
  assert.deepEqual(observed.cohort, {
    ...cohort, recordDigest: registry.cohorts[0].record_digest,
    qualificationEventDigest: registry.events[0].event_digest,
  });
  assert.deepEqual(observed.coordinates.map(({ name }) => name), descriptors.map(([, name]) => name));
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

test("supporting MCP npm lock pins its fixed package and the Cohort Docs Protocol coordinate", () => {
  const docs = authority.coordinates.find(({ key }) => key === "docsProtocol");
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": {
        devDependencies: {
          [docs.name]: docs.version,
          [supportingMcp.name]: supportingMcp.version,
        },
      },
      [`node_modules/${docs.name}`]: {
        version: docs.version,
        integrity: docs.integrity,
        resolved: `https://registry.npmjs.org/${docs.name}/-/${docs.name.split("/").at(-1)}-${docs.version}.tgz`,
      },
      [`node_modules/${supportingMcp.name}`]: {
        version: supportingMcp.version,
        integrity: supportingMcp.integrity,
        resolved: `https://registry.npmjs.org/${supportingMcp.name}/-/${supportingMcp.name.split("/").at(-1)}-${supportingMcp.version}.tgz`,
      },
    },
  };
  const bytes = () => Buffer.from(JSON.stringify(lock));
  assert.doesNotThrow(() => assertSupportingMcpNpmLockCoordinates(bytes(), authority, supportingMcp));
  lock.packages[`node_modules/${supportingMcp.name}`].version = "0.1.1";
  assert.throws(() => assertSupportingMcpNpmLockCoordinates(bytes(), authority, supportingMcp), /lock evidence/u);
  lock.packages[`node_modules/${supportingMcp.name}`].version = supportingMcp.version;
  lock.packages[""].devDependencies[supportingMcp.name] = "latest";
  assert.throws(() => assertSupportingMcpNpmLockCoordinates(bytes(), authority, supportingMcp), /exact trusted versions/u);
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
    supportingReleasePrecondition: {
      status: "passed",
      package: {
        ...supportingMcp,
        latest: supportingMcp.version,
        signatureVerified: true,
        provenanceCommit: commit,
        provenanceAncestorOfExpectedCommit: true,
        tarballEntries: 3,
      },
      install: {
        manager: "npm",
        lockfileDigest: sha256("d"),
        rootCount: 2,
        exactPackageLockValidated: true,
        cohortDocsProtocolLockValidated: true,
        exactRegistryResolved: true,
        manifestValidated: true,
      },
      mcp: {
        serverName: supportingMcp.name,
        serverVersion: supportingMcp.version,
        startupValidated: true,
        readOnlyToolNames: ["docs_info", "docs_find", "docs_context"],
        readOnlyToolsValidated: true,
        consumerTreeUnchanged: true,
        cleanShutdown: true,
      },
    },
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
  assert.equal(receipt.packages.length, 5);
  assert.equal(receipt.supportingReleasePrecondition.package.name, SUPPORTING_MCP_PACKAGE.name);
  const duplicate = structuredClone(receipt);
  duplicate.packages[1].name = duplicate.packages[0].name;
  assert.equal(validate(duplicate), false);
  const falseSupportingClaim = structuredClone(receipt);
  falseSupportingClaim.supportingReleasePrecondition.mcp.consumerTreeUnchanged = false;
  assert.equal(validate(falseSupportingClaim), false);
});

test("workflow is manual and capture plus digest precede the earliest installed import", async () => {
  const source = await readFile(new URL("../.github/workflows/public-managed-registry-canary.yml", import.meta.url), "utf8");
  const runnerSource = await readFile(new URL("../scripts/public-managed-registry-canary.mjs", import.meta.url), "utf8");
  const mcpRunnerSource = await readFile(new URL("../scripts/public-managed-registry-canary-mcp.mjs", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).toSorted(), ["authority_revision", "cohort_id", "expected_commit"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs.qualify.steps[0].with["fetch-depth"], 0);
  assert.equal(JSON.stringify(workflow).includes("secrets."), false);
  assert.doesNotMatch(source, /npm\s+(?:publish|unpublish|deprecate|dist-tag)|pnpm\s+publish/u);
  assert.match(source, /pnpm build/u);
  assert.match(source, /Run read-only six-package public managed registry canary/u);
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
  const supportingInstall = mcpRunnerSource.indexOf("async function installSupportingMcp");
  const supportingCapture = mcpRunnerSource.indexOf("const lockfile = await readFile", supportingInstall);
  const supportingCopy = mcpRunnerSource.indexOf("const lockfileBytes = Buffer.from(lockfile)", supportingCapture);
  const supportingDigest = mcpRunnerSource.indexOf("const lockfileDigest = sha256(lockfileBytes)", supportingCopy);
  const supportingLockValidation = mcpRunnerSource.indexOf("assertSupportingMcpNpmLockCoordinates", supportingDigest);
  const supportingQualification = mcpRunnerSource.indexOf("async function qualifySupportingMcp");
  const supportingSignature = mcpRunnerSource.indexOf("const signatureEvidence = await npmSignatureEvidence", supportingQualification);
  const supportingInventory = mcpRunnerSource.indexOf("const inventory = await packInventory", supportingSignature);
  const supportingProvenance = mcpRunnerSource.indexOf("const provenance = verifiedProvenanceFromNpmAudit", supportingInventory);
  const supportingExecution = mcpRunnerSource.indexOf("await verifyRegistryDocsProtocolMcp", supportingProvenance);
  assert.ok(
    supportingInstall >= 0 && supportingCapture > supportingInstall && supportingCopy > supportingCapture &&
    supportingDigest > supportingCopy && supportingLockValidation > supportingDigest &&
    supportingQualification >= 0 && supportingSignature > supportingQualification &&
    supportingInventory > supportingSignature && supportingProvenance > supportingInventory &&
    supportingExecution > supportingProvenance,
  );
  assert.match(runnerSource, /6 exact release packages \(5 Cohort \+ supporting MCP\)/u);
});
