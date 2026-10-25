import {
  commit,
  authorityRevision,
  sha256,
  digest,
  integrity,
  descriptors,
  cohortV2DependencyEdges,
  cohortV2Schemas,
  cohort,
  inputs,
  projected,
  repository,
  currentPackageAuthority,
  canonicalJson,
  registryFixture,
  strictFixtureProjector,
  centralFetcher,
} from "./support/managed-registry-canary-fixture.ts";
import * as workflowCases from "./support/managed-registry-canary-workflow-cases.ts";
void workflowCases;
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import { stringify } from "yaml";

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
import { runDocsProtocolQualificationV3 } from "../packages/docs-protocol-agent-teams/dist/qualification/index.js";
import { successorQualificationFixture } from "../packages/docs-protocol-agent-teams/tests/public-managed-registry-canary-generation3-fixtures.ts";

const authority = createCanaryAuthority(projected, inputs);
const supportingMcp = {
  ...SUPPORTING_MCP_PACKAGE,
  integrity: integrity(40),
};

test("workflow inputs are minimal non-circular authority references", () => {
  assert.deepEqual(inputs, {
    authorityRevision,
    cohortId: cohort.cohortId,
    expectedCommit: commit,
  });
  assert.throws(
    () => parseCanaryInputs({ ...inputs, authorityRevision: "0".repeat(40) }),
    /nonzero/u,
  );
  assert.throws(() => parseCanaryInputs({ ...inputs, cohortId: "../escape" }), /cohort ID/u);
  assert.deepEqual(
    authority.roots.map(({ name }) => name),
    descriptors.filter(([, , direct]) => direct).map(([, name]) => name),
  );
  assert.equal(authority.coordinates.length, 5);
  assert.equal(
    authority.coordinates.some(({ name }) => name === SUPPORTING_MCP_PACKAGE.name),
    false,
  );
});

test("supporting MCP precondition selects the current release coordinate and rejects stale publication", () => {
  const { name, version } = SUPPORTING_MCP_PACKAGE;
  const manifest = JSON.parse(
    readFileSync(new URL("../packages/docs-protocol-mcp/package.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(SUPPORTING_MCP_PACKAGE, { name: manifest.name, version: manifest.version });
  const packument = {
    "dist-tags": { latest: version },
    versions: { [version]: { name, version, dist: { integrity: supportingMcp.integrity } } },
  };
  assert.deepEqual(supportingMcpCoordinate(packument), supportingMcp);
  const differentVersion = `${BigInt(version.split(".")[0]) + 1n}.0.0`;
  const previous = {
    name,
    version: differentVersion,
    dist: { integrity: supportingMcp.integrity },
  };
  assert.throws(
    () =>
      supportingMcpCoordinate({
        "dist-tags": { latest: previous.version },
        versions: { [previous.version]: previous },
      }),
    /exact latest/u,
  );
  for (const mutate of [
    (value) => {
      delete value.versions[version];
    },
    (value) => {
      value.versions[version].name = "@agent-teams/docs-protocol";
    },
    (value) => {
      value.versions[version].version = differentVersion;
    },
    (value) => {
      value["dist-tags"].latest = differentVersion;
    },
    (value) => {
      delete value["dist-tags"].latest;
    },
  ]) {
    const invalid = structuredClone(packument);
    mutate(invalid);
    assert.throws(() => supportingMcpCoordinate(invalid), /exact latest/u);
  }
  const drift = structuredClone(packument);
  drift.versions[version].dist.integrity = "sha512-not-canonical";
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
    observeCentralCohortAuthority(
      { inputs, repository },
      {
        fetcher: centralFetcher({ branchProtected: false }),
        projectAuthority: strictFixtureProjector,
      },
    ),
    /current protected-main SHA/u,
  );
  await assert.rejects(
    observeCentralCohortAuthority(
      { inputs, repository },
      {
        fetcher: centralFetcher({ branchSha: "c".repeat(40) }),
        projectAuthority: strictFixtureProjector,
      },
    ),
    /current protected-main SHA/u,
  );
});

test("central authority uses the production generation-2 projector", async () => {
  const registry = {
    schema_version: 1,
    cohorts: [
      {
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
          repository: cohort.workflow.repository,
          repository_id: 1316243981,
          path: cohort.workflow.path,
          revision: cohort.workflow.revision,
          blob_sha: cohort.workflow.blobSha,
        },
        assets: {
          skill: {
            package: descriptors[3][1],
            path: "skills/docs/SKILL.md",
            digest: cohort.assets.skillDigest,
          },
          caller_workflow: {
            package: descriptors[3][1],
            path: "assets/docs-protocol.yml",
            digest: sha256("a"),
            rendered_digest: cohort.assets.callerWorkflowDigest,
          },
          asset_catalog: {
            package: descriptors[3][1],
            path: "assets/catalog.json",
            digest: cohort.assets.assetCatalogDigest,
          },
          transition_catalog: {
            package: descriptors[3][1],
            path: "assets/transition-catalog.json",
            digest: cohort.assets.transitionCatalogDigest,
          },
        },
        schemas: cohortV2Schemas,
        runtime: {
          node: cohort.runtime.node,
          pnpm: cohort.runtime.pnpm,
          apply_platforms: ["linux", "macos"],
          check_plan_platforms: ["linux", "macos", "windows"],
        },
        runtime_closure: {
          schema_version: 2,
          domain: "agent-teams.docs-runtime-closure/v2",
          package_manager: "pnpm@11.20.0",
          lockfile_version: "9.0",
          package_count: 5,
          projection_path: `governance/docs-runtime-closures/${cohort.runtime.runtimeClosureDigest.replace(
            ":",
            "-",
          )}.json`,
          digest: cohort.runtime.runtimeClosureDigest,
        },
        canary_repositories: [
          {
            repository_id: Number(repository.id),
            repository: repository.nameWithOwner,
          },
        ],
      },
    ],
    events: [
      {
        sequence: 1,
        cohort_id: cohort.cohortId,
        state: "QUALIFIED",
        effective_at: cohort.eligibleAfter,
        support_until: null,
        evidence_references: ["test:public-managed-registry-canary-qualified"],
        canary_evidence: [],
        previous_event_digest: null,
        event_digest: cohort.qualificationEventDigest,
      },
    ],
  };
  const { record_digest: _recordDigest, ...recordBody } = registry.cohorts[0];
  registry.cohorts[0].record_digest = digest(
    canonicalJson({
      domain: "agent-teams.docs-qualified-cohort/v2",
      body: recordBody,
    }),
  );
  const { event_digest: _eventDigest, ...eventBody } = registry.events[0];
  registry.events[0].event_digest = digest(
    canonicalJson({
      domain: "agent-teams.docs-qualified-cohort-event/v1",
      body: eventBody,
    }),
  );
  const observed = await observeCentralCohortAuthority(
    { inputs, repository },
    { fetcher: centralFetcher({ registry }) },
  );
  assert.deepEqual(observed.cohort, {
    ...cohort,
    recordDigest: registry.cohorts[0].record_digest,
    qualificationEventDigest: registry.events[0].event_digest,
  });
  assert.deepEqual(
    observed.coordinates.map(({ name }) => name),
    descriptors.map(([, name]) => name),
  );
});

test("central selection rejects missing, duplicate, wrong-generation, and non-canary Cohorts", async () => {
  for (const registry of [
    registryFixture([]),
    registryFixture([
      { cohort_id: cohort.cohortId, cohort_generation: 2 },
      { cohort_id: cohort.cohortId, cohort_generation: 2 },
    ]),
    registryFixture([{ cohort_id: cohort.cohortId, cohort_generation: 1 }]),
    {
      ...registryFixture(),
      events: [
        {
          sequence: 1,
          cohort_id: cohort.cohortId,
          state: "PUBLISHED_UNQUALIFIED",
          event_digest: sha256("a"),
        },
      ],
    },
  ]) {
    await assert.rejects(
      observeCentralCohortAuthority(
        { inputs, repository },
        {
          fetcher: centralFetcher({ registry }),
          projectAuthority: strictFixtureProjector,
        },
      ),
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
        return new Response(
          JSON.stringify({ protected: true, commit: { sha: authorityRevision } }),
        );
      }
      if (value.endsWith("docs-qualified-cohorts.json")) {
        return new Response(body, { headers: { "content-type": "application/json" } });
      }
      return centralFetcher()(url);
    };
    await assert.rejects(
      observeCentralCohortAuthority(
        { inputs, repository },
        {
          fetcher: hostileFetcher,
          projectAuthority: async () => {
            projectionCalls += 1;
            return projected;
          },
        },
      ),
      /byte-size limit|duplicate-free/u,
    );
    assert.equal(projectionCalls, 0);
  }
});

test("live registry observations are independent and fail on authority mismatch", () => {
  const observations = Object.fromEntries(
    authority.coordinates.map(({ name, version, integrity: sri }) => [
      name,
      {
        version,
        integrity: sri,
        latest: version,
      },
    ]),
  );
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
      version: coordinate.version,
      integrity: coordinate.integrity,
    };
    pnpmPackages[`${coordinate.name}@${coordinate.version}`] = {
      resolution: { integrity: coordinate.integrity },
    };
  }
  assert.doesNotThrow(() =>
    assertNpmLockCoordinates(Buffer.from(JSON.stringify({ packages: npmPackages })), authority),
  );
  assert.doesNotThrow(() =>
    assertPnpmLockCoordinates(
      Buffer.from(
        stringify({
          lockfileVersion: "9.0",
          packages: pnpmPackages,
          snapshots: {},
          importers: { ".": {} },
        }),
      ),
      authority,
    ),
  );

  npmPackages["node_modules/@agent-teams/docs-protocol-mcp"] = {
    version: "1.0.0",
    integrity: integrity(30),
  };
  assert.throws(
    () =>
      assertNpmLockCoordinates(Buffer.from(JSON.stringify({ packages: npmPackages })), authority),
    /MCP/u,
  );
  pnpmPackages["@agent-teams/docs-protocol-mcp@1.0.0"] = {
    resolution: { integrity: integrity(30) },
  };
  assert.throws(
    () => assertPnpmLockCoordinates(Buffer.from(stringify({ packages: pnpmPackages })), authority),
    /MCP/u,
  );
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
  assert.doesNotThrow(() =>
    assertSupportingMcpNpmLockCoordinates(bytes(), authority, supportingMcp),
  );
  lock.packages[`node_modules/${supportingMcp.name}`].version = "0.1.1";
  assert.throws(
    () => assertSupportingMcpNpmLockCoordinates(bytes(), authority, supportingMcp),
    /lock evidence/u,
  );
  lock.packages[`node_modules/${supportingMcp.name}`].version = supportingMcp.version;
  lock.packages[""].devDependencies[supportingMcp.name] = "latest";
  assert.throws(
    () => assertSupportingMcpNpmLockCoordinates(bytes(), authority, supportingMcp),
    /exact trusted versions/u,
  );
});

test("partial publication and missing adapter fail closed", () => {
  const observations = Object.fromEntries(
    authority.coordinates.map(({ name, version }) => [name, { version }]),
  );
  assert.equal(publicationClosureDecision(authority, observations).status, "ready");
  delete observations["@agent-teams/docs-protocol-agent-teams"];
  assert.equal(publicationClosureDecision(authority, observations).status, "rejected");
});

test("tarball and portable boundaries reject aliases, links, and managed authority", () => {
  assert.deepEqual(
    assertSafeTarballInventory(["package/package.json", "package/dist/index.js"], "fixture"),
    ["package/package.json", "package/dist/index.js"],
  );
  for (const entries of [
    ["package/../escape"],
    ["/package/index.js"],
    ["package\\index.js"],
    ["package/cafe\u0301.js"],
    ["package/File.js", "package/file.js"],
  ]) {
    assert.throws(() => assertSafeTarballInventory(entries, "fixture"), /rejected/u);
  }
  assert.throws(
    () => assertTarballEntryTypes("lrwxr-xr-x 0/0 0 package/link -> target\n", "fixture"),
    /link/u,
  );
  assert.throws(
    () =>
      assertPortableCoreClosure({
        dependencies: {},
        entries: ["package/dist/runDocsProtocolQualificationV3.js"],
      }),
    /managed authority/u,
  );
});

test("hostile matrix makes no managed interruption execution claim", () => {
  const matrix = hostilePolicyMatrix(authority);
  assert.equal(matrix.length, 8);
  assert.ok(
    matrix.every(({ mode, outcome }) => mode === "deterministic-policy" && outcome === "rejected"),
  );
  assert.equal(JSON.stringify(matrix).includes("interruption"), false);
});

test("nested qualification and managed-state digests are independently canonical", () => {
  const qualificationBody = {
    schemaVersion: 3,
    cohortAdmissible: true,
    profileSchemaVersion: 3,
    cohort: {
      schemaVersion: 2,
      cohortId: cohort.cohortId,
      recordDigest: cohort.recordDigest,
      qualificationEventDigest: cohort.qualificationEventDigest,
    },
    packages: authority.coordinates.map(({ key, name, version, integrity: sri }) => ({
      key,
      name,
      version,
      integrity: sri,
    })),
    schemas: cohort.schemas,
    runtime: { runtimeClosureDigest: cohort.runtime.runtimeClosureDigest },
    checks: [
      "profile-v3",
      "cohort-v2",
      "five-package-closure",
      "exact-package-versions",
      "exact-package-integrities",
      "schema-bindings-3-2-1",
      "runtime-closure-digest",
    ],
  };
  const qualificationReceipt = {
    ...qualificationBody,
    receiptDigest: digest(canonicalJson(qualificationBody)),
  };
  assert.doesNotThrow(() => assertQualificationReceiptDigest(qualificationReceipt));
  assert.throws(
    () => assertQualificationReceiptDigest({ ...qualificationReceipt, cohortAdmissible: false }),
    /receipt digest/u,
  );

  const stateBody = { schemaVersion: 2 };
  const stateDigest = digest(
    canonicalJson({ domain: "agent-teams.docs-protocol.managed-state/v2", body: stateBody }),
  );
  const serialization = `${canonicalJson({ ...stateBody, stateDigest })}\n`;
  assert.equal(assertCanonicalManagedState(serialization).stateDigest, stateDigest);
  assert.throws(() => assertCanonicalManagedState(serialization.slice(0, -1)), /newline/u);
});

test("canonical canary receipt validates central binding and exact unique package provenance", async () => {
  const qualificationBody = {
    schemaVersion: 3,
    cohortAdmissible: true,
    profileSchemaVersion: 3,
    cohort: {
      schemaVersion: 2,
      cohortId: cohort.cohortId,
      recordDigest: cohort.recordDigest,
      qualificationEventDigest: cohort.qualificationEventDigest,
    },
    packages: authority.coordinates.map(({ key, name, version, integrity: sri }) => ({
      key,
      name,
      version,
      integrity: sri,
    })),
    schemas: cohort.schemas,
    runtime: { runtimeClosureDigest: cohort.runtime.runtimeClosureDigest },
    checks: [
      "profile-v3",
      "cohort-v2",
      "five-package-closure",
      "exact-package-versions",
      "exact-package-integrities",
      "schema-bindings-3-2-1",
      "runtime-closure-digest",
    ],
  };
  const qualificationReceipt = {
    ...qualificationBody,
    receiptDigest: digest(canonicalJson(qualificationBody)),
  };
  const stateBody = { schemaVersion: 2 };
  const stateDigest = digest(
    canonicalJson({ domain: "agent-teams.docs-protocol.managed-state/v2", body: stateBody }),
  );
  const receipt = finalizeCanaryReceipt({
    schemaVersion: 1,
    run: {
      repository: "agent-teams-ai/engineering-foundation",
      runId: 1,
      runAttempt: 1,
      createdAt: "2026-09-04T12:00:00.000Z",
    },
    authority: {
      central: authority.central,
      cohort,
      expectedCommit: commit,
      registry: authority.registry,
    },
    packages: authority.coordinates.map(({ name, version, integrity: sri }) => ({
      name,
      version,
      integrity: sri,
      latest: version,
      provenanceCommit: commit,
      provenanceAncestorOfExpectedCommit: true,
      tarballEntries: 3,
    })),
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
    installs: ["npm", "pnpm"].map((manager) => ({
      manager,
      lockfileDigest: sha256("b"),
      rootCount: 3,
      fivePackageLockValidated: true,
      mcpAbsent: true,
    })),
    portableNegative: {
      adapterAbsent: true,
      forbiddenTermsAbsent: true,
      lockfileDigest: sha256("c"),
    },
    managedQualification: {
      actualRuntimeClosureDigest: cohort.runtime.runtimeClosureDigest,
      managedState: {
        schemaVersion: 2,
        schemaValidated: true,
        serialization: `${canonicalJson({ ...stateBody, stateDigest })}\n`,
        stateDigest,
      },
      qualificationReceipt,
      schemaEvidence: { consumerIntegration: 3, managedState: 2, docsProtocol: 1, validated: true },
    },
    hostile: [
      ...hostilePolicyMatrix(authority),
      { id: "tarball-inventory", mode: "installed-execution", outcome: "passed" },
      { id: "portable-managed-denylist", mode: "installed-execution", outcome: "passed" },
      { id: "qualification-v3", mode: "installed-execution", outcome: "passed" },
      { id: "managed-state-v2-schema", mode: "installed-execution", outcome: "passed" },
    ],
  });
  const schema = JSON.parse(
    await readFile(
      new URL(
        "../architecture/foundation/schemas/public-managed-registry-canary-receipt-v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
  assert.doesNotThrow(() => assertCanaryReceiptDigest(receipt));
  assert.equal(receipt.packages.length, 5);
  assert.equal(receipt.supportingReleasePrecondition.package.name, SUPPORTING_MCP_PACKAGE.name);
  for (const [section, field] of [
    ["package", "version"],
    ["package", "latest"],
    ["mcp", "serverVersion"],
  ]) {
    const staleSupportingCoordinate = structuredClone(receipt);
    staleSupportingCoordinate.supportingReleasePrecondition[section][field] =
      `${BigInt(supportingMcp.version.split(".")[0]) + 1n}.0.0`;
    assert.equal(
      validate(staleSupportingCoordinate),
      true,
      "schema describes structure, not release authority",
    );
    assert.throws(() => finalizeCanaryReceipt(staleSupportingCoordinate), /supporting release/u);
    staleSupportingCoordinate.supportingReleasePrecondition[section][field] = "^1.0.0";
    assert.equal(validate(staleSupportingCoordinate), false);
  }
  const stale = structuredClone(receipt);
  const differentVersion = `${BigInt(supportingMcp.version.split(".")[0]) + 1n}.0.0`;
  stale.supportingReleasePrecondition.package.version = differentVersion;
  stale.supportingReleasePrecondition.package.latest = differentVersion;
  stale.supportingReleasePrecondition.mcp.serverVersion = differentVersion;
  assert.equal(validate(stale), true);
  assert.throws(() => finalizeCanaryReceipt(stale), /exact latest/u);
  for (const [section, field] of [
    ["package", "name"],
    ["mcp", "serverName"],
  ]) {
    const wrongName = structuredClone(receipt);
    wrongName.supportingReleasePrecondition[section][field] = "@agent-teams/docs-protocol";
    assert.equal(validate(wrongName), false);
    assert.throws(() => finalizeCanaryReceipt(wrongName), /supporting release/u);
  }
  const invalidIntegrity = structuredClone(receipt);
  invalidIntegrity.supportingReleasePrecondition.package.integrity = "sha512-not-canonical";
  assert.throws(() => finalizeCanaryReceipt(invalidIntegrity), /canonical sha512 SRI/u);
  const duplicate = structuredClone(receipt);
  duplicate.packages[1].name = duplicate.packages[0].name;
  assert.equal(validate(duplicate), false);
  const falseSupportingClaim = structuredClone(receipt);
  falseSupportingClaim.supportingReleasePrecondition.mcp.consumerTreeUnchanged = false;
  assert.equal(validate(falseSupportingClaim), false);
});

test("policy createCanaryAuthority accepts packed policy26 and support receipt is not CANARY", async (t) => {
  const successor = successorQualificationFixture();
  const projectedCohort3 = {
    repository: "agent-teams-ai/.github",
    path: "governance/docs-qualified-cohorts.json",
    revision: authorityRevision,
    cohort: structuredClone(successor.profile.cohort),
  };
  const inputs3 = parseCanaryInputs({
    authorityRevision,
    cohortId: successor.profile.cohort.cohortId,
    expectedCommit: commit,
  });
  const authority3 = createCanaryAuthority(projectedCohort3, inputs3);
  assert.deepEqual(Object.keys(authority3.cohort).toSorted(), [
    "assets",
    "candidateDigest",
    "channel",
    "cohortId",
    "eligibleAfter",
    "packages",
    "qualificationEventDigest",
    "recordDigest",
    "rollbackTo",
    "runtime",
    "schemaVersion",
    "schemas",
    "upgradeFrom",
    "workflow",
  ]);
  for (const field of ["lifecycle", "lifecycleState", "canaryIds", "canaryRepositoryIds"]) {
    assert.equal(field in projectedCohort3.cohort, false);
    assert.equal(field in authority3.cohort, false);
  }
  assert.deepEqual(authority3.cohort.runtime.policy, {
    id: "agent-teams.docs-protocol-current-policy",
    version: "3.0.0",
    digest: successor.runtimePolicy.sourceDigest,
  });

  const rejected = structuredClone(projectedCohort3);
  rejected.cohort.runtime.policy.digest = sha256("a");
  assert.throws(
    () => createCanaryAuthority(rejected, inputs3),
    /Cohort v3 runtime authority is invalid/u,
  );

  // Physical qualification observes pnpm from an owned declared pnpm consumer,
  // never from the repository's separate Bun installation context.
  const qualificationRoot = await mkdtemp(join(tmpdir(), "TEST-canary-pnpm-observation-"));
  t.after(() => rm(qualificationRoot, { recursive: true, force: true }));
  await writeFile(
    join(qualificationRoot, "package.json"),
    JSON.stringify({
      name: "TEST-canary-pnpm-observation",
      private: true,
      packageManager: "pnpm@11.20.0",
    }),
  );
  await writeFile(join(qualificationRoot, "pnpm-workspace.yaml"), "packages: []\n");
  const supportQualification = () => {
    const originalDirectory = process.cwd();
    try {
      process.chdir(qualificationRoot);
      return runDocsProtocolQualificationV3({
        profile: successor.profile,
        evidence: successor.evidence,
        lockfileBytes: successor.lockfileBytes,
      });
    } finally {
      process.chdir(originalDirectory);
    }
  };
  if (
    process.versions.node === "26.11.1" &&
    process.platform === "linux" &&
    process.arch === "x64"
  ) {
    const receipt = supportQualification();
    assert.equal(receipt.cohortAdmissible, true);
    for (const field of ["state", "canaryState", "canaryRepositoryIds", "canaryEligible"]) {
      assert.equal(field in receipt, false);
      assert.equal(field in receipt.cohort, false);
    }
  } else {
    assert.throws(
      supportQualification,
      /Qualification Cohort v3 observed Node runtime mismatch\./u,
    );
  }
  assert.equal(successor.runtimePolicy.managedCandidate.selected, false);
  assert.equal(successor.runtimePolicy.managedCandidate.status, "candidate-unqualified");
  assert.equal(successor.runtimePolicy.managedRuntime.status, "candidate-unqualified");
});
