import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  NPM_PACKAGE_BOOTSTRAP,
  assertBootstrapMutationPreconditions,
  assertBootstrapPostconditions,
  assertBootstrapQuarantineCandidate,
  assertBootstrapQuarantinePostconditions,
  assertBootstrapReleasePolicy,
  assertReusableBootstrap,
  assertOneDayGranularTokenWindow,
  auditLivePackage,
  bootstrapPackageById,
  classifyRegistryPreflight,
  observeRegistryPreflight,
  parseBootstrapCatalog,
  validatePackEvidence,
  verifyLiveBootstrapBaselines,
  verifyReleaseBootstrapBaselines,
} from "../scripts/npm-package-bootstrap.mjs";
import {
  assertWorkspaceManifestMatchesProfile,
  prove as proveLiveBootstrap,
  proveQuarantine,
} from "../scripts/npm-package-bootstrap-cli.mjs";
import { main as releasePublishMain } from "../scripts/release-publish.mjs";

const mcpProfile = bootstrapPackageById("docs-protocol-agent-teams", { approved: true });
const reviewedCommit = "a".repeat(40);

function integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function approvedMcpCatalog(archiveBytes = Buffer.from("reviewed archive")) {
  const value = structuredClone(NPM_PACKAGE_BOOTSTRAP);
  value.packages = [structuredClone(mcpProfile)];
  value.packages[0].state = "approved";
  value.packages[0].approval = {
    archiveIntegrity: integrity(archiveBytes),
    packageTree: "b".repeat(40),
  };
  return parseBootstrapCatalog(value);
}

function candidateMcpCatalog() {
  const value = structuredClone(NPM_PACKAGE_BOOTSTRAP);
  value.packages = [structuredClone(mcpProfile)];
  value.packages[0].state = "candidate";
  value.packages[0].approval = null;
  return parseBootstrapCatalog(value);
}

function auditEvidence(profile, commit = reviewedCommit) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{
      name: `pkg:npm/%40${profile.name.slice(1)}@${profile.bootstrapVersion}`,
      digest: {
        sha512: Buffer.from(
          profile.approval.archiveIntegrity.slice("sha512-".length),
          "base64",
        ).toString("hex"),
      },
    }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: NPM_PACKAGE_BOOTSTRAP.repository,
            path: profile.provenance.workflowPath,
            ref: profile.provenance.ref,
          },
        },
        resolvedDependencies: [{
          uri: `git+${NPM_PACKAGE_BOOTSTRAP.repository}@${profile.provenance.ref}`,
          digest: { gitCommit: commit },
        }],
      },
    },
  };
  return {
    invalid: [],
    missing: [],
    verified: [{
      name: profile.name,
      version: profile.bootstrapVersion,
      attestations: {
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
      attestationBundles: [{
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: {
            payloadType: "application/vnd.in-toto+json",
            payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
          },
        },
      }, {
        predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
        bundle: {},
      }],
    }],
  };
}

function bootstrapMetadata(profile, extraVersions = []) {
  return {
    versions: [profile.bootstrapVersion, ...extraVersions],
    "dist-tags": { bootstrap: profile.bootstrapVersion, latest: profile.bootstrapVersion },
  };
}

function releaseState(profile, version) {
  return {
    packages: {
      private: [],
      public: [{
        manifestBytes: JSON.stringify({ name: profile.name, version }),
        name: profile.name,
        version,
      }],
    },
  };
}

test("bootstrap catalog is closed, data-only, and owns approved and historical package states", () => {
  assert.deepEqual(
    NPM_PACKAGE_BOOTSTRAP.packages.map(({ id, state }) => ({ id, state })),
    [
      { id: "repository-mutation", state: "approved" }, { id: "docs-protocol", state: "historical" },
      { id: "docs-protocol-agent-teams", state: "approved" }, { id: "docs-protocol-mcp", state: "historical" },
    ],
  );
  assert.notEqual(mcpProfile.approval, null);
  assert.throws(
    () => bootstrapPackageById("unknown", { approved: true }),
    /closed bootstrap catalog/u,
  );
  assert.equal(bootstrapPackageById("docs-protocol-agent-teams", { approved: true }), mcpProfile);
  assert.throws(() => bootstrapPackageById("docs-protocol-mcp", { approved: true }), /not approved/u);

  for (const mutation of [
    (value) => { value.extra = true; },
    (value) => { value.packages[0].root = "../escape"; },
    (value) => { value.packages.find(({ id }) => id === "docs-protocol-agent-teams").dependencies[0].version = "latest"; },
    (value) => { value.packages.find(({ id }) => id === "docs-protocol-agent-teams").dependencies[3].specifier = "latest"; },
    (value) => { value.packages[0].contentPolicy.prefixes = ["dist/file.js"]; },
    (value) => { value.packages[0].approval.packageTree = "not-a-tree"; },
    (value) => { value.packages[1].approval = { archiveIntegrity: "bad", packageTree: "a".repeat(40) }; },
  ]) {
    const value = structuredClone(NPM_PACKAGE_BOOTSTRAP);
    mutation(value);
    assert.throws(() => parseBootstrapCatalog(value), /bootstrap refused/u);
  }
});

test("bootstrap workspace authority distinguishes internal and catalog dependencies", async () => {
  const manifest = Object.assign(JSON.parse(await readFile(
    new URL("../packages/docs-protocol-agent-teams/package.json", import.meta.url),
    "utf8",
  )), { version: mcpProfile.bootstrapVersion });
  assert.doesNotThrow(() => assertWorkspaceManifestMatchesProfile(mcpProfile, manifest));

  const catalogDrift = structuredClone(manifest);
  catalogDrift.dependencies.ajv = "workspace:*";
  assert.throws(
    () => assertWorkspaceManifestMatchesProfile(mcpProfile, catalogDrift),
    /specifier mismatch for ajv/u,
  );

  const unexpectedDependency = structuredClone(manifest);
  unexpectedDependency.dependencies["unexpected-package"] = "1.0.0";
  assert.throws(
    () => assertWorkspaceManifestMatchesProfile(mcpProfile, unexpectedDependency),
    /runtime dependency names differ/u,
  );
});

test("bootstrap accepts only a live granular token window of at most one day", () => {
  assert.doesNotThrow(() => assertOneDayGranularTokenWindow({
    createdAt: "2026-08-29T00:00:00Z",
    expiresAt: "2026-08-30T00:00:00Z",
    now: "2026-08-29T12:00:00Z",
  }));
  for (const input of [
    {
      createdAt: "2026-08-29T00:00:00Z",
      expiresAt: "2026-08-30T00:00:01Z",
      now: "2026-08-29T12:00:00Z",
    },
    {
      createdAt: "2026-08-29T12:00:01Z",
      expiresAt: "2026-08-30T00:00:00Z",
      now: "2026-08-29T12:00:00Z",
    },
    {
      createdAt: "2026-08-29T00:00:00Z",
      expiresAt: "2026-08-29T12:14:59Z",
      now: "2026-08-29T12:00:00Z",
    },
  ]) {
    assert.throws(() => assertOneDayGranularTokenWindow(input), /bootstrap refused/u);
  }
});

test("pack evidence binds identity, dependency, allowlist, tree, and reviewed SRI", () => {
  const tarPayload = Buffer.from("portable tar payload".repeat(4_096));
  const archiveBytes = gzipSync(tarPayload, { level: 9 });
  const foreignGzipWrapper = gzipSync(tarPayload, { level: 1 });
  assert.deepEqual(gunzipSync(foreignGzipWrapper), gunzipSync(archiveBytes));
  assert.notDeepEqual(foreignGzipWrapper, archiveBytes);
  const catalog = approvedMcpCatalog(archiveBytes);
  const profile = catalog.packages[0];
  const archivePath = resolve("/tmp/agent-teams-docs-protocol-agent-teams-0.0.0.tgz");
  const files = ["CHANGELOG.md", "LICENSE", "README.md", "dist/index.js", "package.json", "skills/docs/SKILL.md"];
  const input = {
    archivePath,
    archiveBytes,
    packageTree: profile.approval.packageTree,
    packedManifest: {
      name: profile.name,
      version: profile.bootstrapVersion,
      dependencies: Object.fromEntries(
        profile.dependencies.map(({ name, version }) => [name, version]),
      ),
      publishConfig: {
        access: "public",
        provenance: true,
        registry: NPM_PACKAGE_BOOTSTRAP.registry,
      },
    },
    packReport: [{
      filename: archivePath,
      files: files.map((path) => ({ path })),
      name: profile.name,
      version: profile.bootstrapVersion,
    }],
    profile,
    tarEntries: files.map((path) => `package/${path}`),
    tarVerboseListing: files.map((path) => `-rw-r--r-- 0 0 0 1 Jan 1 00:00 package/${path}`).join("\n"),
  };
  assert.deepEqual(validatePackEvidence(input), {
    archivePath: input.packReport[0].filename,
    integrity: profile.approval.archiveIntegrity,
  });
  for (const mutation of [
    (value) => { value.packageTree = "c".repeat(40); },
    (value) => { value.archiveBytes = Buffer.from("different"); },
    (value) => { value.archiveBytes = foreignGzipWrapper; },
    (value) => { value.packedManifest.dependencies["@agent-teams/docs-protocol"] = "0.3.1"; },
    (value) => { value.packedManifest.dependencies["unexpected-package"] = "1.0.0"; },
    (value) => { value.packedManifest.optionalDependencies = {}; },
    (value) => { value.archivePath = resolve("/tmp/different-archive.tgz"); },
    (value) => { value.packReport[0].files.push({ path: "secret.env" }); },
    (value) => { value.tarEntries.pop(); },
    (value) => { value.tarVerboseListing = value.tarVerboseListing.replace(/^-/, "l"); },
    (value) => { value.archiveBytes = Buffer.alloc(8 * 1024 * 1024 + 1); },
  ]) {
    const value = structuredClone(input);
    value.archiveBytes = Buffer.from(input.archiveBytes);
    mutation(value);
    assert.throws(() => validatePackEvidence(value), /bootstrap refused/u);
  }
});

test("registry preflight publishes only a proven absent namespace and resumes only exact bytes", () => {
  const profile = approvedMcpCatalog().packages[0];
  const base = {
    dependencyVersions: Object.fromEntries(
      profile.dependencies.map(({ name, version }) => [name, version]),
    ),
    localIntegrity: profile.approval.archiveIntegrity,
    profile,
  };
  assert.equal(classifyRegistryPreflight({
    ...base,
    packageMetadata: null,
    publishedIntegrity: null,
  }), "publish");
  assert.equal(classifyRegistryPreflight({
    ...base,
    packageMetadata: bootstrapMetadata(profile),
    publishedIntegrity: profile.approval.archiveIntegrity,
  }), "reuse");
  for (const mutation of [
    (value) => { value.dependencyVersions[profile.dependencies[0].name] = null; },
    (value) => { value.dependencyVersions[profile.dependencies.at(-1).name] = null; },
    (value) => { value.publishedIntegrity = integrity(Buffer.from("foreign")); },
    (value) => { value.packageMetadata.versions.push("0.0.1"); },
    (value) => { value.packageMetadata["dist-tags"].foreign = "0.0.0"; },
  ]) {
    const value = {
      ...base,
      dependencyVersions: { ...base.dependencyVersions },
      packageMetadata: structuredClone(bootstrapMetadata(profile)),
      publishedIntegrity: profile.approval.archiveIntegrity,
    };
    mutation(value);
    assert.throws(() => classifyRegistryPreflight(value), /bootstrap refused/u);
  }
});

test("registry preflight requires bounded repeated 404 evidence before publish", async () => {
  const profile = approvedMcpCatalog().packages[0];
  let packageAttempts = 0;
  const action = await observeRegistryPreflight(profile, profile.approval.archiveIntegrity, {
    fetchImplementation: async (url) => {
      const packageName = decodeURIComponent(new URL(url).pathname.slice(1));
      if (packageName === profile.name) {
        packageAttempts += 1;
        return new Response("not found", { status: 404 });
      }
      const dependency = profile.dependencies.find(({ name }) => name === packageName);
      return new Response(JSON.stringify({ versions: { [dependency.version]: {} } }), { status: 200 });
    },
    observationOptions: { attempts: 3, wait: async () => {} },
  });
  assert.equal(action, "publish");
  assert.equal(packageAttempts, 3);
});

test("reuse proof rejects a dist-tag race before token-bearing mutations", () => {
  const profile = approvedMcpCatalog().packages[0];
  const packageMetadata = bootstrapMetadata(profile);
  assert.equal(classifyRegistryPreflight({
    dependencyVersions: Object.fromEntries(
      profile.dependencies.map(({ name, version }) => [name, version]),
    ),
    localIntegrity: profile.approval.archiveIntegrity,
    packageMetadata,
    profile,
    publishedIntegrity: profile.approval.archiveIntegrity,
  }), "reuse");
  packageMetadata["dist-tags"].foreign = profile.bootstrapVersion;
  assert.throws(() => assertReusableBootstrap({
    auditEvidence: auditEvidence(profile),
    expectedCommit: reviewedCommit,
    localIntegrity: profile.approval.archiveIntegrity,
    packageMetadata,
    profile,
    publishedIntegrity: profile.approval.archiveIntegrity,
  }), /unexpected bootstrap dist-tag/u);
});

test("mutation proof audits first and rejects registry state changed during the audit", async () => {
  const profile = mcpProfile;
  const mutableMetadata = bootstrapMetadata(profile);
  const events = [];
  await assert.rejects(() => proveLiveBootstrap(
    ["docs-protocol-agent-teams", profile.approval.archiveIntegrity, reviewedCommit, "unused.json"],
    assertBootstrapMutationPreconditions,
    "bootstrap mutation target remained absent.",
    {
      auditPackage: async () => {
        events.push("audit");
        mutableMetadata["dist-tags"].foreign = profile.bootstrapVersion;
        return auditEvidence(profile);
      },
      liveEvidence: async () => {
        events.push("fresh-registry-read");
        return {
          deprecatedMessage: null,
          integrity: profile.approval.archiveIntegrity,
          metadata: structuredClone(mutableMetadata),
        };
      },
      writeEvidence: async () => { events.push("write-evidence"); },
    },
  ), /unexpected bootstrap dist-tag/u);
  assert.deepEqual(events, ["audit", "fresh-registry-read"]);
});

test("mutation proof stores only validated evidence fields", async () => {
  const profile = mcpProfile;
  const remoteCanary = "UNTRUSTED_REMOTE_EVIDENCE_CANARY";
  let written;
  const audit = auditEvidence(profile);
  audit.remoteCanary = remoteCanary;
  await proveLiveBootstrap(
    ["docs-protocol-agent-teams", profile.approval.archiveIntegrity, reviewedCommit, "evidence.json"],
    assertBootstrapMutationPreconditions,
    "bootstrap mutation target remained absent.",
    {
      auditPackage: async () => audit,
      liveEvidence: async () => ({
        deprecatedMessage: remoteCanary,
        integrity: profile.approval.archiveIntegrity,
        metadata: bootstrapMetadata(profile),
      }),
      writeEvidence: async (_path, value) => { written = value; },
    },
  );
  const evidence = JSON.parse(written);
  assert.equal(written.includes(remoteCanary), false);
  assert.equal(evidence.live.deprecationMatches, false);
  assert.equal(evidence.package.integrity, profile.approval.archiveIntegrity);
  assert.equal(evidence.provenance.commit, reviewedCommit);
  assert.equal(evidence.verified, true);
});

test("mutation proof retries stale registry metadata without repeating its audit", async () => {
  let audits = 0;
  const reads = [];
  const waits = [];
  let writes = 0;
  await proveLiveBootstrap(
    ["docs-protocol-agent-teams", mcpProfile.approval.archiveIntegrity, reviewedCommit, "evidence.json"],
    assertBootstrapMutationPreconditions,
    "bootstrap mutation target remained absent.",
    {
      assertionAttempts: 3,
      auditPackage: async () => {
        audits += 1;
        return auditEvidence(mcpProfile);
      },
      liveEvidence: async (_profile, _fetch, options) => {
        reads.push(options);
        return {
          deprecatedMessage: null,
          integrity: reads.length === 1 ? null : mcpProfile.approval.archiveIntegrity,
          metadata: reads.length === 1
            ? { versions: [], "dist-tags": {} }
            : bootstrapMetadata(mcpProfile),
        };
      },
      wait: async (milliseconds) => { waits.push(milliseconds); },
      writeEvidence: async () => { writes += 1; },
    },
  );
  assert.equal(audits, 1);
  assert.equal(reads.length, 2);
  assert.ok(reads.every((options) => options.attempts === 1 && options.retryNotFound === true));
  assert.deepEqual(waits, [5_000]);
  assert.equal(writes, 1);
});

test("mutation proof fails after bounded retries when registry metadata stays stale", async () => {
  let audits = 0;
  let reads = 0;
  const waits = [];
  let writes = 0;
  await assert.rejects(() => proveLiveBootstrap(
    ["docs-protocol-agent-teams", mcpProfile.approval.archiveIntegrity, reviewedCommit, "evidence.json"],
    assertBootstrapMutationPreconditions,
    "bootstrap mutation target remained absent.",
    {
      assertionAttempts: 3,
      auditPackage: async () => {
        audits += 1;
        return auditEvidence(mcpProfile);
      },
      liveEvidence: async () => {
        reads += 1;
        return { deprecatedMessage: null, integrity: null, metadata: { versions: [], "dist-tags": {} } };
      },
      wait: async (milliseconds) => { waits.push(milliseconds); },
      writeEvidence: async () => { writes += 1; },
    },
  ), /registry versions/u);
  assert.equal(audits, 1);
  assert.equal(reads, 3);
  assert.deepEqual(waits, [5_000, 5_000]);
  assert.equal(writes, 0);
});

test("npm signature audit uses the shared cross-platform command runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-bootstrap-runner-test-"));
  const calls = [];
  const expected = { invalid: [], missing: [], verified: [] };
  try {
    const result = await auditLivePackage(mcpProfile, root, {
      attempts: 1,
      runNpm: async (args, cwd, options) => {
        calls.push({ args, cwd, options });
        return {
          stderr: "",
          stdout: args[0] === "audit" ? JSON.stringify(expected) : "",
        };
      },
    });
    assert.deepEqual(result, expected);
    assert.deepEqual(calls.map(({ args }) => args[0]), ["install", "audit"]);
    assert.equal(calls[0].cwd, calls[1].cwd);
    assert.ok(calls.every(({ options }) => options.timeoutMs === 120_000));
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("quarantine deprecates exact bytes but never substitutes for provenance", () => {
  const profile = approvedMcpCatalog().packages[0];
  const artifact = {
    localIntegrity: profile.approval.archiveIntegrity,
    packageMetadata: bootstrapMetadata(profile),
    profile,
    publishedIntegrity: profile.approval.archiveIntegrity,
  };
  assert.doesNotThrow(() => assertBootstrapQuarantineCandidate(artifact));
  assert.doesNotThrow(() => assertBootstrapQuarantinePostconditions({
    ...artifact,
    deprecatedMessage: profile.deprecationMessage,
  }));
  assert.throws(() => assertBootstrapQuarantinePostconditions({
    ...artifact,
    deprecatedMessage: null,
  }), /exact deprecation message/u);
  const missingProvenance = auditEvidence(profile);
  missingProvenance.missing.push({ name: profile.name });
  assert.throws(() => assertBootstrapMutationPreconditions({
    ...artifact,
    auditEvidence: missingProvenance,
    expectedCommit: reviewedCommit,
  }), /bootstrap refused/u);
});

test("quarantine postconditions retry a stale deprecation before writing evidence", async () => {
  const reads = [];
  const waits = [];
  let writes = 0;
  await proveQuarantine(
    ["docs-protocol-agent-teams", mcpProfile.approval.archiveIntegrity, "evidence.json"],
    assertBootstrapQuarantinePostconditions,
    {
      assertionAttempts: 3,
      liveEvidence: async (_profile, _fetch, options) => {
        reads.push(options);
        return {
          deprecatedMessage: reads.length === 1 ? null : mcpProfile.deprecationMessage,
          integrity: mcpProfile.approval.archiveIntegrity,
          metadata: bootstrapMetadata(mcpProfile),
        };
      },
      wait: async (milliseconds) => { waits.push(milliseconds); },
      writeEvidence: async () => { writes += 1; },
    },
  );
  assert.equal(reads.length, 2);
  assert.ok(reads.every((options) => options.attempts === 1 && options.retryNotFound === true));
  assert.deepEqual(waits, [5_000]);
  assert.equal(writes, 1);
});

test("quarantine postconditions fail boundedly when deprecation stays stale", async () => {
  let reads = 0;
  const waits = [];
  let writes = 0;
  await assert.rejects(() => proveQuarantine(
    ["docs-protocol-agent-teams", mcpProfile.approval.archiveIntegrity, "evidence.json"],
    assertBootstrapQuarantinePostconditions,
    {
      assertionAttempts: 3,
      liveEvidence: async () => {
        reads += 1;
        return {
          deprecatedMessage: null,
          integrity: mcpProfile.approval.archiveIntegrity,
          metadata: bootstrapMetadata(mcpProfile),
        };
      },
      wait: async (milliseconds) => { waits.push(milliseconds); },
      writeEvidence: async () => { writes += 1; },
    },
  ), /exact deprecation message/u);
  assert.equal(reads, 3);
  assert.deepEqual(waits, [5_000, 5_000]);
  assert.equal(writes, 0);
});

test("postconditions require exact registry state, deprecation, signature audit, and provenance", () => {
  const profile = approvedMcpCatalog().packages[0];
  const input = {
    auditEvidence: auditEvidence(profile),
    deprecatedMessage: profile.deprecationMessage,
    expectedCommit: reviewedCommit,
    localIntegrity: profile.approval.archiveIntegrity,
    packageMetadata: bootstrapMetadata(profile),
    profile,
    publishedIntegrity: profile.approval.archiveIntegrity,
  };
  assert.doesNotThrow(() => assertBootstrapPostconditions(input));
  for (const mutation of [
    (value) => { value.deprecatedMessage = "different deprecation"; },
    (value) => { value.expectedCommit = "c".repeat(40); },
    (value) => { value.auditEvidence.invalid.push({ name: profile.name }); },
    (value) => { value.packageMetadata["dist-tags"].latest = "0.0.1"; },
  ]) {
    const value = structuredClone(input);
    mutation(value);
    assert.throws(() => assertBootstrapPostconditions(value), /bootstrap refused/u);
  }
});

test("postconditions retry stale registry metadata until the exact deprecation converges", async () => {
  let audits = 0;
  const reads = [];
  const waits = [];
  let written;
  await proveLiveBootstrap(
    ["docs-protocol-agent-teams", mcpProfile.approval.archiveIntegrity, reviewedCommit, "evidence.json"],
    assertBootstrapPostconditions,
    "published bootstrap package remained absent.",
    {
      assertionAttempts: 3,
      auditPackage: async () => {
        audits += 1;
        return auditEvidence(mcpProfile);
      },
      liveEvidence: async (_profile, _fetch, options) => {
        reads.push(options);
        return {
          deprecatedMessage: reads.length === 1 ? null : mcpProfile.deprecationMessage,
          integrity: mcpProfile.approval.archiveIntegrity,
          metadata: bootstrapMetadata(mcpProfile),
        };
      },
      wait: async (milliseconds) => { waits.push(milliseconds); },
      writeEvidence: async (_path, value) => { written = value; },
    },
  );
  assert.equal(audits, 1);
  assert.equal(reads.length, 2);
  assert.ok(reads.every((options) => options.attempts === 1 && options.retryNotFound === true));
  assert.deepEqual(waits, [5_000]);
  assert.equal(JSON.parse(written).live.deprecationMatches, true);
});

test("postconditions fail after the bounded attempts when registry metadata stays stale", async () => {
  let audits = 0;
  let reads = 0;
  const waits = [];
  let writes = 0;
  await assert.rejects(() => proveLiveBootstrap(
    ["docs-protocol-agent-teams", mcpProfile.approval.archiveIntegrity, reviewedCommit, "evidence.json"],
    assertBootstrapPostconditions,
    "published bootstrap package remained absent.",
    {
      assertionAttempts: 3,
      auditPackage: async () => {
        audits += 1;
        return auditEvidence(mcpProfile);
      },
      liveEvidence: async () => {
        reads += 1;
        return {
          deprecatedMessage: null,
          integrity: mcpProfile.approval.archiveIntegrity,
          metadata: bootstrapMetadata(mcpProfile),
        };
      },
      wait: async (milliseconds) => { waits.push(milliseconds); },
      writeEvidence: async () => { writes += 1; },
    },
  ), /exact deprecation message/u);
  assert.equal(audits, 1);
  assert.equal(reads, 3);
  assert.deepEqual(waits, [5_000, 5_000]);
  assert.equal(writes, 0);
});

test("release policy blocks a package transition until approved baseline exists", () => {
  const candidateCatalog = candidateMcpCatalog();
  const candidate = candidateCatalog.packages[0];
  assert.throws(() => assertBootstrapReleasePolicy(
    releaseState(candidate, "0.0.0"),
    [{ name: candidate.name, versions: [] }],
    candidateCatalog,
  ), /reviewed bootstrap approval/u);
  assert.throws(() => assertBootstrapReleasePolicy(
    releaseState(candidate, "0.1.0"),
    [{ name: candidate.name, versions: [] }],
    candidateCatalog,
  ), /reviewed bootstrap approval/u);

  const approvedCatalog = approvedMcpCatalog();
  const profile = approvedCatalog.packages[0];
  assert.throws(() => assertBootstrapReleasePolicy(
    releaseState(profile, "0.0.0"),
    [{ name: profile.name, versions: [] }],
    approvedCatalog,
  ), /immutable 0\.0\.0 npm baseline/u);
  assert.throws(() => assertBootstrapReleasePolicy(
    releaseState(profile, "0.1.0"),
    [{ name: profile.name, versions: [] }],
    approvedCatalog,
  ), /immutable 0\.0\.0 npm baseline/u);
  assert.doesNotThrow(() => assertBootstrapReleasePolicy(
    releaseState(profile, "0.1.0"),
    [{ name: profile.name, versions: ["0.0.0"] }],
    approvedCatalog,
  ));
});

test("ordinary release proves full bootstrap evidence before registry reads or writes", async () => {
  const state = {
    inventory: { metadata: ["README.md", "config.json"], pending: [], unexpected: [] },
    packages: { private: [], public: [{ manifestBytes: "{}", name: "fixture", version: "1.0.0" }] },
    preState: undefined,
  };
  const events = [];
  await assert.rejects(() => releasePublishMain({
    inspectReleaseState: async () => state,
    publishOrdered: async () => { events.push("publish"); },
    verifyBootstrapBaselines: async () => {
      events.push("bootstrap");
      throw new Error("baseline proof failed");
    },
    verifyRegistry: async () => { events.push("registry"); },
  }), /baseline proof failed/u);
  assert.deepEqual(events, ["bootstrap"]);
});

test("ordinary release baseline proof never skips a local bootstrap manifest", async () => {
  const catalog = approvedMcpCatalog();
  const profile = catalog.packages[0];
  let fetches = 0;
  await assert.rejects(() => verifyReleaseBootstrapBaselines({
    auditPackage: async () => auditEvidence(profile),
    catalog,
    fetchImplementation: async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        versions: {
          "0.0.0": {
            deprecated: profile.deprecationMessage,
            dist: { integrity: integrity(Buffer.from("foreign archive")) },
          },
        },
        "dist-tags": { bootstrap: "0.0.0", latest: "0.0.0" },
      }), { status: 200 });
    },
    observationOptions: { attempts: 1, wait: async () => {} },
    readManifest: async () => ({ name: profile.name, version: profile.bootstrapVersion }),
  }), /does not match reviewed immutable evidence/u);
  assert.equal(fetches, 2);
});

test("live baseline verification distinguishes absent, unknown, conflict, and verified evidence", async () => {
  const catalog = approvedMcpCatalog();
  const profile = catalog.packages[0];
  const packument = {
    versions: {
      "0.0.0": {
        deprecated: profile.deprecationMessage,
        dist: { integrity: profile.approval.archiveIntegrity },
      },
      "0.1.0": { dist: { integrity: integrity(Buffer.from("release")) } },
    },
    "dist-tags": { bootstrap: "0.0.0", latest: "0.1.0" },
  };
  const common = {
    auditPackage: async () => auditEvidence(profile),
    catalog,
    observationOptions: { attempts: 3, wait: async () => {} },
    readManifest: async () => ({ name: profile.name, version: "0.1.0" }),
  };
  assert.deepEqual(await verifyLiveBootstrapBaselines({
    ...common,
    fetchImplementation: async () => new Response(JSON.stringify(packument), { status: 200 }),
  }), [`${profile.name}@0.0.0`]);

  await assert.rejects(() => verifyLiveBootstrapBaselines({
    ...common,
    fetchImplementation: async () => new Response("not found", { status: 404 }),
  }), /baseline is absent/u);

  let attempts = 0;
  await assert.rejects(() => verifyLiveBootstrapBaselines({
    ...common,
    fetchImplementation: async () => {
      attempts += 1;
      return new Response("unavailable", { status: 503 });
    },
  }), /remained unknown/u);
  assert.equal(attempts, 3);

  const conflict = structuredClone(packument);
  delete conflict.versions["0.0.0"];
  await assert.rejects(() => verifyLiveBootstrapBaselines({
    ...common,
    fetchImplementation: async () => new Response(JSON.stringify(conflict), { status: 200 }),
  }), /baseline is missing/u);
});

test("release baseline proof audits before its fresh mutable registry snapshot", async () => {
  const catalog = approvedMcpCatalog();
  const profile = catalog.packages[0];
  const events = [];
  let registryReads = 0;
  await assert.rejects(() => verifyReleaseBootstrapBaselines({
    auditPackage: async () => {
      events.push("audit");
      return auditEvidence(profile);
    },
    catalog,
    fetchImplementation: async () => {
      registryReads += 1;
      events.push(registryReads === 1 ? "initial-registry-read" : "fresh-registry-read");
      return new Response(JSON.stringify({
        versions: {
          "0.0.0": {
            deprecated: profile.deprecationMessage,
            dist: { integrity: profile.approval.archiveIntegrity },
          },
        },
        "dist-tags": registryReads === 1
          ? { bootstrap: "0.0.0", latest: "0.1.0" }
          : { bootstrap: "0.1.0", latest: "0.1.0" },
      }), { status: 200 });
    },
    observationOptions: { attempts: 1, wait: async () => {} },
    readManifest: async () => ({ name: profile.name, version: "0.1.0" }),
  }), /bootstrap tag does not resolve/u);
  assert.deepEqual(events, ["initial-registry-read", "audit", "fresh-registry-read"]);
});

test("live baseline verification blocks a candidate before network access", async () => {
  const catalog = candidateMcpCatalog();
  const candidate = catalog.packages[0];
  let fetched = false;
  await assert.rejects(() => verifyLiveBootstrapBaselines({
    catalog,
    fetchImplementation: async () => {
      fetched = true;
      return new Response("not found", { status: 404 });
    },
    readManifest: async () => ({ name: candidate.name, version: "0.1.0" }),
  }), /before reviewed bootstrap approval/u);
  assert.equal(fetched, false);
});
