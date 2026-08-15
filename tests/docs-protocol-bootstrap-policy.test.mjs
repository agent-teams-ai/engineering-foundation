import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import {
  DOCS_PROTOCOL_BOOTSTRAP,
  assertBootstrapPostconditions,
  assertBootstrapPromotionManifest,
  assertOneDayGranularTokenWindow,
  assertOrdinaryReleaseBootstrapState,
  classifyRegistryPreflight,
  ordinaryReleaseDocsPolicy,
  validatePackEvidence,
} from "../scripts/docs-protocol-bootstrap.mjs";

function provenanceAuditEvidence(statement) {
  return {
    invalid: [],
    missing: [],
    verified: [
      {
        attestationBundles: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              dsseEnvelope: {
                payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
                payloadType: "application/vnd.in-toto+json",
              },
            },
          },
        ],
        attestations: {
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
        },
        name: DOCS_PROTOCOL_BOOTSTRAP.name,
        version: DOCS_PROTOCOL_BOOTSTRAP.version,
      },
    ],
  };
}

function stagingManifests() {
  return {
    changesetsConfig: { ignore: [DOCS_PROTOCOL_BOOTSTRAP.name] },
    docsManifest: {
      dependencies: { [DOCS_PROTOCOL_BOOTSTRAP.foundationName]: "workspace:*" },
      name: DOCS_PROTOCOL_BOOTSTRAP.name,
      private: true,
      version: DOCS_PROTOCOL_BOOTSTRAP.version,
    },
    foundationManifest: {
      name: DOCS_PROTOCOL_BOOTSTRAP.foundationName,
      version: DOCS_PROTOCOL_BOOTSTRAP.foundationVersion,
    },
  };
}

test("ordinary release fails closed around the private Docs Protocol bootstrap state", () => {
  const staging = stagingManifests();
  assert.doesNotThrow(() =>
    assertOrdinaryReleaseBootstrapState({
      ...staging,
      publishablePackageNames: [DOCS_PROTOCOL_BOOTSTRAP.foundationName],
    }),
  );
  for (const mutation of [
    (input) => {
      input.docsManifest.private = false;
    },
    (input) => {
      input.changesetsConfig.ignore = [];
    },
    (input) => {
      input.publishablePackageNames.push(DOCS_PROTOCOL_BOOTSTRAP.name);
    },
    (input) => {
      input.docsManifest.publishConfig = { provenance: true };
    },
  ]) {
    const input = {
      ...stagingManifests(),
      publishablePackageNames: [DOCS_PROTOCOL_BOOTSTRAP.foundationName],
    };
    mutation(input);
    assert.throws(() => assertOrdinaryReleaseBootstrapState(input), /bootstrap refused/u);
  }
});

test("bootstrap promotion requires the exact public manifest and Foundation RC", () => {
  const input = stagingManifests();
  input.changesetsConfig.ignore = [];
  delete input.docsManifest.private;
  input.docsManifest.publishConfig = {
    access: "public",
    provenance: true,
    registry: DOCS_PROTOCOL_BOOTSTRAP.registry,
  };
  assert.doesNotThrow(() => assertBootstrapPromotionManifest(input));
  input.foundationManifest.version = "0.17.0-rc.1";
  assert.throws(() => assertBootstrapPromotionManifest(input), /Foundation 0\.17\.0-rc\.0/u);
});

test("ordinary release command accepts the promoted Docs Protocol prerelease", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/docs-protocol-bootstrap.mjs"), "ordinary-release-state"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("ordinary prerelease cannot create the public Docs Protocol stable baseline", () => {
  const input = stagingManifests();
  input.changesetsConfig.ignore = [];
  delete input.docsManifest.private;
  input.docsManifest.publishConfig = {
    access: "public",
    provenance: true,
    registry: DOCS_PROTOCOL_BOOTSTRAP.registry,
  };
  const policy = {
    ...input,
    preState: { mode: "pre", tag: "rc" },
    publishablePackageNames: [
      DOCS_PROTOCOL_BOOTSTRAP.foundationName,
      DOCS_PROTOCOL_BOOTSTRAP.name,
    ],
  };
  assert.throws(
    () => ordinaryReleaseDocsPolicy({ ...policy, registryVersion: undefined }),
    /stable Docs Protocol 0\.0\.0 baseline/u,
  );
  assert.equal(
    ordinaryReleaseDocsPolicy({
      ...policy,
      registryVersion: DOCS_PROTOCOL_BOOTSTRAP.version,
    }),
    "published-bootstrap",
  );
  assert.equal(
    ordinaryReleaseDocsPolicy({
      ...policy,
      docsManifest: { ...policy.docsManifest, version: "0.1.0-rc.0" },
      registryVersion: DOCS_PROTOCOL_BOOTSTRAP.version,
    }),
    "public-release",
  );
});

test("bootstrap accepts only a live granular token window of at most one day", () => {
  assert.doesNotThrow(() =>
    assertOneDayGranularTokenWindow({
      createdAt: "2026-08-14T00:00:00Z",
      expiresAt: "2026-08-15T00:00:00Z",
      now: "2026-08-14T12:00:00Z",
    }),
  );
  assert.throws(
    () =>
      assertOneDayGranularTokenWindow({
        createdAt: "2026-08-14T00:00:00Z",
        expiresAt: "2026-08-15T00:00:01Z",
        now: "2026-08-14T12:00:00Z",
      }),
    /no more than one day/u,
  );
});

test("bootstrap binds closed tarball contents and the packed Foundation dependency", () => {
  const paths = [
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "dist/index.js",
    "package.json",
    "schemas/docs-protocol-command-envelope/v1.schema.json",
    "schemas/docs-protocol-profile/v1.schema.json",
    "schemas/docs-protocol/v1.schema.json",
  ];
  const packReport = {
    files: paths.map((path) => ({ path })),
    filename: resolve("agent-teams-docs-protocol-0.0.0.tgz"),
    name: DOCS_PROTOCOL_BOOTSTRAP.name,
    version: DOCS_PROTOCOL_BOOTSTRAP.version,
  };
  const packedManifest = {
    dependencies: {
      [DOCS_PROTOCOL_BOOTSTRAP.foundationName]: DOCS_PROTOCOL_BOOTSTRAP.foundationVersion,
    },
    name: DOCS_PROTOCOL_BOOTSTRAP.name,
    version: DOCS_PROTOCOL_BOOTSTRAP.version,
  };
  const evidence = validatePackEvidence({
    archiveBytes: Buffer.from("fixture tarball", "utf8"),
    packedManifest,
    packReport,
    tarEntries: paths.map((path) => `package/${path}`),
  });
  assert.match(evidence.integrity, /^sha512-/u);
  packReport.files.push({ path: "src/secret.ts" });
  assert.throws(
    () =>
      validatePackEvidence({
        archiveBytes: Buffer.from("fixture tarball", "utf8"),
        packedManifest,
        packReport,
        tarEntries: paths.map((path) => `package/${path}`),
      }),
    /closed Docs Protocol allowlist/u,
  );
});

test("registry bootstrap is absent-or-exact and proves final tags, deprecation, and provenance", () => {
  const integrity = "sha512-fixture";
  const reviewedCommit = DOCS_PROTOCOL_BOOTSTRAP.artifactCommit;
  assert.equal(
    classifyRegistryPreflight({
      docsMetadata: null,
      foundationVersion: DOCS_PROTOCOL_BOOTSTRAP.foundationVersion,
      localIntegrity: integrity,
      publishedIntegrity: null,
    }),
    "publish",
  );
  const docsMetadata = {
    "dist-tags": {
      bootstrap: DOCS_PROTOCOL_BOOTSTRAP.version,
      latest: DOCS_PROTOCOL_BOOTSTRAP.version,
    },
    versions: [DOCS_PROTOCOL_BOOTSTRAP.version],
  };
  const fixtureDigest = Buffer.alloc(64, 1);
  const canonicalIntegrity = `sha512-${fixtureDigest.toString("base64")}`;
  const provenanceStatement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: "pkg:npm/%40agent-teams/docs-protocol@0.0.0",
        digest: {
          sha512: fixtureDigest.toString("hex"),
        },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            ref: "refs/heads/main",
            repository: "https://github.com/agent-teams-ai/engineering-foundation",
            path: ".github/workflows/docs-protocol-bootstrap.yml",
          },
        },
        resolvedDependencies: [
          {
            uri: "git+https://github.com/agent-teams-ai/engineering-foundation@refs/heads/main",
            digest: { gitCommit: reviewedCommit },
          },
        ],
      },
    },
  };
  assert.equal(
    classifyRegistryPreflight({
      docsMetadata,
      foundationVersion: DOCS_PROTOCOL_BOOTSTRAP.foundationVersion,
      localIntegrity: integrity,
      publishedIntegrity: integrity,
    }),
    "reuse",
  );
  assert.doesNotThrow(() =>
    assertBootstrapPostconditions({
      auditEvidence: provenanceAuditEvidence(provenanceStatement),
      deprecatedMessage: DOCS_PROTOCOL_BOOTSTRAP.deprecationMessage,
      docsMetadata,
      localIntegrity: canonicalIntegrity,
      publishedIntegrity: canonicalIntegrity,
      reviewedCommit,
    }),
  );
  for (const mutate of [
    (statement) => {
      statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
        "b".repeat(40);
    },
    (statement) => {
      statement.predicate.buildDefinition.externalParameters.workflow.repository =
        "https://github.com/example/wrong";
    },
    (statement) => {
      statement.predicate.buildDefinition.externalParameters.workflow.path =
        ".github/workflows/wrong.yml";
    },
    (statement) => {
      statement.subject[0].name = "pkg:npm/%40agent-teams/docs-protocol@0.0.1";
    },
    (statement) => {
      statement.subject[0].digest.sha512 = "00".repeat(64);
    },
  ]) {
    const mismatchedStatement = structuredClone(provenanceStatement);
    mutate(mismatchedStatement);
    assert.throws(
      () =>
        assertBootstrapPostconditions({
          auditEvidence: provenanceAuditEvidence(mismatchedStatement),
          deprecatedMessage: DOCS_PROTOCOL_BOOTSTRAP.deprecationMessage,
          docsMetadata,
          localIntegrity: canonicalIntegrity,
          publishedIntegrity: canonicalIntegrity,
          reviewedCommit,
        }),
      /reviewed repository, workflow, commit, and tarball/u,
    );
  }
  delete docsMetadata["dist-tags"].latest;
  assert.throws(
    () =>
      assertBootstrapPostconditions({
        auditEvidence: { invalid: [], missing: [], verified: [] },
        deprecatedMessage: DOCS_PROTOCOL_BOOTSTRAP.deprecationMessage,
        docsMetadata,
        localIntegrity: integrity,
        publishedIntegrity: integrity,
      }),
    /dist-tag/u,
  );
  docsMetadata["dist-tags"].latest = DOCS_PROTOCOL_BOOTSTRAP.version;
  docsMetadata["dist-tags"].rc = DOCS_PROTOCOL_BOOTSTRAP.version;
  assert.throws(
    () =>
      classifyRegistryPreflight({
        docsMetadata,
        foundationVersion: DOCS_PROTOCOL_BOOTSTRAP.foundationVersion,
        localIntegrity: integrity,
        publishedIntegrity: integrity,
      }),
    /unexpected Docs Protocol dist-tag/u,
  );
  delete docsMetadata["dist-tags"].rc;
  assert.throws(
    () =>
      classifyRegistryPreflight({
        docsMetadata,
        foundationVersion: DOCS_PROTOCOL_BOOTSTRAP.foundationVersion,
        localIntegrity: integrity,
        publishedIntegrity: "sha512-other",
      }),
    /exact reviewed tarball/u,
  );
});
