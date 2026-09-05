import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { main as runPublishedCompatibility } from "../scripts/published-compatibility-e2e.mjs";

import { verifyGithubTagRelease } from "../scripts/github-release-reconciliation.mjs";
import { npmPurlName } from "../scripts/release-publish-ordered.mjs";
import {
  assertRegistryOnlyInstallEvidence,
  requirePublicDocsDecision,
  verifyPublicExactDocsCoordinates,
} from "../scripts/public-docs-install-e2e.mjs";
import {
  main as runPublicDocsReleaseQualification,
  publicDocsReleaseQualificationDecision,
} from "../scripts/public-docs-release-e2e.mjs";

const releaseAuthorityFixture = {
  packages: {
    cli: { name: "@agent-teams/docs-protocol", version: "0.4.0" },
    mcp: { name: "@agent-teams/docs-protocol-mcp", version: "0.1.0" },
  },
};

function releaseFixture(versions) {
  return {
    packages: {
      public: Object.entries(versions).map(([name, version]) => ({ name, version })),
    },
  };
}

function integrity(character) {
  return `sha512-${Buffer.alloc(64, character).toString("base64")}`;
}

function publishedEvidence(coordinates, mutate = (value) => value) {
  return Object.fromEntries(coordinates.map((coordinate, index) => {
    const value = {
      integrity: integrity(index + 1),
      latest: coordinate.version,
      versions: [coordinate.version],
    };
    return [coordinate.name, mutate(value, coordinate, index)];
  }));
}

function forgedAuditEvidence(coordinates, published) {
  return {
    invalid: [],
    missing: [],
    verified: coordinates.map(({ name, version }) => {
      const sha512 = Buffer.from(
        published[name].integrity.slice("sha512-".length),
        "base64",
      ).toString("hex");
      const statement = {
        _type: "https://in-toto.io/Statement/v1",
        predicate: { buildDefinition: {
          externalParameters: { workflow: {
            path: ".github/workflows/release.yml",
            ref: "refs/heads/main",
            repository: "https://github.com/example/forged",
          } },
          resolvedDependencies: [{
            digest: { gitCommit: "a".repeat(40) },
            uri: "git+https://github.com/example/forged@refs/heads/main",
          }],
        } },
        predicateType: "https://slsa.dev/provenance/v1",
        subject: [{
          digest: { sha512 },
          name: `pkg:npm/${npmPurlName(name)}@${version}`,
        }],
      };
      return {
        attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
        attestationBundles: [
          { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1" },
          {
            bundle: { dsseEnvelope: {
              payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
              payloadType: "application/vnd.in-toto+json",
            } },
            predicateType: "https://slsa.dev/provenance/v1",
          },
        ],
        name,
        version,
      };
    }),
  };
}

test("public install evidence rejects workspace, link, and file dependency escape hatches", () => {
  const localProtocols = [
    "workspace:*", "link:../docs", "file:../docs.tgz", "git+file:///tmp/docs",
  ];
  const exact = {
    lockfile: [
      "lockfileVersion: '9.0'",
      "settings:",
      "  excludeLinksFromLockfile: false",
      "metadata:",
      "  profile: strict",
      "  resolved: https://registry.npmjs.org/profile:metadata",
      "resolution: {integrity: sha512-exact}",
      "",
    ].join("\n"),
    manifests: [{
      manifest: {
        dependencies: { "@example/foundation": "1.2.3" },
        name: "@example/docs",
        version: "1.2.3",
      },
      name: "@example/docs",
      version: "1.2.3",
    }],
  };
  assert.doesNotThrow(() => assertRegistryOnlyInstallEvidence(exact));
  for (const protocol of localProtocols) {
    const input = structuredClone(exact);
    input.manifests[0].manifest.dependencies["@example/foundation"] = protocol;
    assert.throws(() => assertRegistryOnlyInstallEvidence(input), /local dependency/u);
    assert.throws(() => assertRegistryOnlyInstallEvidence({
      ...exact,
      lockfile: `${exact.lockfile}specifier: ${protocol}\n`,
    }), /lockfile contains a local/u);
  }
  for (const protocol of localProtocols) {
    assert.throws(() => assertRegistryOnlyInstallEvidence({
      ...exact,
      lockfile: `${exact.lockfile}snapshots:\n  '@example/docs@${protocol}': {}\n`,
    }), /lockfile contains a local/u);
  }
  assert.doesNotThrow(() => assertRegistryOnlyInstallEvidence({
    ...exact,
    lockfile: JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { profile: "strict" } },
    }),
  }));
  for (const protocol of localProtocols) {
    assert.throws(() => assertRegistryOnlyInstallEvidence({
      ...exact,
      lockfile: JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/@example/docs": { resolved: protocol } },
      }),
    }), /lockfile contains a local/u);
  }
  assert.throws(() => assertRegistryOnlyInstallEvidence({
    ...exact,
    lockfile: "not: [valid",
  }), /not valid JSON or YAML/u);
});

test("unpublished release-authority coordinate blocks public installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-docs-policy-"));
  try {
    let installed = false;
    const result = await verifyPublicExactDocsCoordinates({ temporaryRoot: root }, {
      installAndQualify: async () => { installed = true; },
      observePublishedPackages: async () => ({}),
    });
    assert.equal(result.status, "pending");
    assert.deepEqual(result.missing, result.coordinates);
    assert.equal(installed, false);
    assert.throws(
      () => requirePublicDocsDecision(result, { required: true }),
      /Required public Docs Protocol coordinates are not available/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("published release-authority coordinates qualify the complete matrix", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-docs-policy-"));
  try {
    const qualified = [];
    const github = [];
    let audits = 0;
    let auditInput;
    const result = await verifyPublicExactDocsCoordinates({ temporaryRoot: root }, {
      auditSignatures: async (input) => { audits += 1; auditInput = input; return {}; },
      installAndQualify: async ({ matrixEntry }) => {
        qualified.push(matrixEntry.id);
        return {
          root: `/disposable/${matrixEntry.id}`,
          userConfigPath: `/disposable/${matrixEntry.id}/npmrc`,
        };
      },
      observePublishedPackages: async (coordinates) => publishedEvidence(coordinates),
      verifyGithub: async (...arguments_) => github.push(arguments_),
      verifyProvenance: () => ({ commit: "a".repeat(40) }),
    });
    assert.equal(result.status, "ready");
    assert.deepEqual(qualified, [
      "npm-docs-only", "npm-docs-mcp", "pnpm-docs-only", "pnpm-docs-mcp",
    ]);
    assert.equal(audits, 1);
    assert.equal(auditInput.root, "/disposable/npm-docs-mcp");
    assert.equal(github.length, 2);
    assert.deepEqual(
      github.map(([tag]) => tag),
      result.coordinates.map(({ name, version }) => `${name}@${version}`),
    );
    assert.ok(github.every(([, commit, options]) =>
      commit === "a".repeat(40) && options.repository === "agent-teams-ai/engineering-foundation"));
    assert.ok(result.artifacts.every(({ integrity: value, latest, version }) =>
      value.startsWith("sha512-") && latest === version));
    assert.equal(result.commit, "a".repeat(40));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("package manifest bumps flow through every public qualification coordinate", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-docs-policy-"));
  try {
    const manifestVersions = new Map([
      ["@agent-teams/docs-protocol", "9.8.7"],
      ["@agent-teams/docs-protocol-mcp", "6.5.4"],
    ]);
    const expected = [...manifestVersions].map(([name, version]) => ({ name, version }));
    const github = [];
    const installs = [];
    const observations = [];
    const provenances = [];
    const result = await verifyPublicExactDocsCoordinates({ temporaryRoot: root }, {
      auditSignatures: async () => ({}),
      installAndQualify: async ({ coordinates, matrixEntry }) => {
        installs.push(coordinates.map(({ name, version }) => ({ name, version })));
        return {
          root: `/disposable/${matrixEntry.id}`,
          userConfigPath: `/disposable/${matrixEntry.id}/npmrc`,
        };
      },
      observePublishedPackages: async (coordinates) => {
        observations.push(coordinates.map(({ name, version }) => ({ name, version })));
        return publishedEvidence(coordinates);
      },
      readPackageManifest: async (path) => {
        const name = path.pathname.endsWith("/docs-protocol-mcp/package.json")
          ? "@agent-teams/docs-protocol-mcp"
          : "@agent-teams/docs-protocol";
        return { name, version: manifestVersions.get(name) };
      },
      verifyGithub: async (tag) => github.push(tag),
      verifyProvenance: (_audit, artifact) => {
        provenances.push({ name: artifact.name, version: artifact.version });
        return { commit: "a".repeat(40) };
      },
    });
    assert.deepEqual(result.coordinates, expected);
    assert.deepEqual(observations, [expected, expected]);
    assert.deepEqual(installs, [expected, expected, expected, expected]);
    assert.deepEqual(provenances, expected);
    assert.deepEqual(github, expected.map(({ name, version }) => `${name}@${version}`));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("public qualification rejects manifest identity and version drift before registry access", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-docs-policy-"));
  try {
    for (const [cliManifest, expected] of [
      [{ name: "@example/forged", version: "9.8.7" }, /untrusted package identity/u],
      [{ name: "@agent-teams/docs-protocol", version: "workspace:*" }, /invalid release version/u],
    ]) {
      let observed = false;
      await assert.rejects(verifyPublicExactDocsCoordinates({ temporaryRoot: root }, {
        observePublishedPackages: async () => {
          observed = true;
          return {};
        },
        readPackageManifest: async (path) => path.pathname.endsWith("/docs-protocol-mcp/package.json")
          ? { name: "@agent-teams/docs-protocol-mcp", version: "6.5.4" }
          : cliManifest,
      }), expected);
      assert.equal(observed, false);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("public observation retries 404 boundedly before returning pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-docs-policy-"));
  try {
    let requests = 0;
    let delays = 0;
    const result = await verifyPublicExactDocsCoordinates({ temporaryRoot: root }, {
      delay: async () => { delays += 1; },
      fetchRegistry: async () => {
        requests += 1;
        return { ok: false, status: 404 };
      },
    });
    assert.equal(result.status, "pending");
    assert.equal(requests, 10);
    assert.equal(delays, 8);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("non-required public observation can use one read without passive retry delay", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-docs-policy-"));
  try {
    let requests = 0;
    let delays = 0;
    const urls = [];
    const result = await verifyPublicExactDocsCoordinates({ temporaryRoot: root }, {
      delay: async () => { delays += 1; },
      fetchRegistry: async (url) => {
        requests += 1;
        urls.push(url);
        return { ok: false, status: 404 };
      },
      observationAttempts: 1,
    });
    assert.equal(result.status, "pending");
    assert.equal(requests, 2);
    assert.equal(delays, 0);
    assert.deepEqual(urls, [
      "https://registry.npmjs.org/%40agent-teams%2Fdocs-protocol",
      "https://registry.npmjs.org/%40agent-teams%2Fdocs-protocol-mcp",
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("public observation rejects malformed successful packuments", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-docs-policy-"));
  try {
    await assert.rejects(
      verifyPublicExactDocsCoordinates({ temporaryRoot: root }, {
        fetchRegistry: async () => ({
          json: async () => ({ name: "missing-versions" }),
          ok: true,
          status: 200,
        }),
      }),
      /malformed versions/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("public qualification rejects latest drift before install", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-docs-policy-"));
  try {
    let installed = false;
    await assert.rejects(verifyPublicExactDocsCoordinates({ temporaryRoot: root }, {
      installAndQualify: async () => { installed = true; },
      observePublishedPackages: async (coordinates) => publishedEvidence(
        coordinates,
        (value, _coordinate, index) => index === 0 ? { ...value, latest: "9.9.9" } : value,
      ),
    }), /latest dist-tag drifted/u);
    assert.equal(installed, false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("public qualification rejects registry drift on its final observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-docs-policy-"));
  try {
    let observations = 0;
    await assert.rejects(verifyPublicExactDocsCoordinates({ temporaryRoot: root }, {
      auditSignatures: async () => ({}),
      installAndQualify: async ({ matrixEntry }) => ({
        root: `/disposable/${matrixEntry.id}`,
        userConfigPath: `/disposable/${matrixEntry.id}/npmrc`,
      }),
      observePublishedPackages: async (coordinates) => {
        observations += 1;
        return publishedEvidence(
          coordinates,
          (value, _coordinate, index) => observations === 2 && index === 0
            ? { ...value, latest: "9.9.9" }
            : value,
        );
      },
      verifyGithub: async () => {},
      verifyProvenance: () => ({ commit: "a".repeat(40) }),
    }), /latest dist-tag drifted/u);
    assert.equal(observations, 2);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("public qualification rejects forged npm provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-docs-policy-"));
  try {
    let coordinates;
    let published;
    await assert.rejects(verifyPublicExactDocsCoordinates({ temporaryRoot: root }, {
      auditSignatures: async () => forgedAuditEvidence(coordinates, published),
      installAndQualify: async () => ({
        root: "/disposable/npm-pair",
        userConfigPath: "/disposable/npmrc",
      }),
      observePublishedPackages: async (value) => {
        coordinates = value;
        published = publishedEvidence(value);
        return published;
      },
      verifyGithub: async () => {},
    }), /verified provenance is not bound/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("read-only GitHub verification rejects tag and release mismatch", async () => {
  const expectedCommit = "a".repeat(40);
  const tag = "@example/docs@1.2.3";
  for (const [refCommit, releaseTag, expected] of [
    ["b".repeat(40), tag, /Git tag is not bound/u],
    [expectedCommit, "@example/docs@9.9.9", /not the exact stable release/u],
  ]) {
    const requests = [];
    const request = (args) => {
      requests.push(args);
      const route = args[0];
      if (route.includes("/git/ref/tags/")) {
        return { object: { sha: refCommit, type: "commit" } };
      }
      if (route.includes("/releases/tags/")) {
        return { draft: false, prerelease: false, tag_name: releaseTag };
      }
      throw new Error(`Unexpected route ${route}`);
    };
    await assert.rejects(verifyGithubTagRelease(tag, expectedCommit, {
      attempts: 1,
      repository: "example/repository",
      request,
    }), expected);
    assert.equal(requests.some((args) => args.includes("--method")), false);
  }
});

test("release qualification derives stable coordinates despite stale authority versions", () => {
  for (const [cliVersion, mcpVersion] of [["0.5.0", "0.2.0"], ["0.4.0", "0.1.0"]]) {
    const coordinates = [
      { name: releaseAuthorityFixture.packages.cli.name, version: cliVersion },
      { name: releaseAuthorityFixture.packages.mcp.name, version: mcpVersion },
    ];
    assert.deepEqual(publicDocsReleaseQualificationDecision({
      authority: releaseAuthorityFixture,
      release: { packages: { public: coordinates.toReversed() } },
    }), { action: "require", coordinates, reason: "exact-release-target" });
  }
});

test("release-aware qualification skips RC, invalid, missing, and unrelated coordinates", () => {
  const targetVersions = {
    [releaseAuthorityFixture.packages.cli.name]: "0.5.0",
    [releaseAuthorityFixture.packages.mcp.name]: "0.2.0",
  };
  for (const name of Object.keys(targetVersions)) {
    for (const version of ["0.5.0-rc.0", "01.2.3", "^0.5.0", "0.5.0+build", "0.5"]) {
      assert.equal(publicDocsReleaseQualificationDecision({
        authority: releaseAuthorityFixture,
        release: releaseFixture({ ...targetVersions, [name]: version }),
      }).action, "skip");
    }
    const incomplete = { ...targetVersions };
    delete incomplete[name];
    assert.equal(publicDocsReleaseQualificationDecision({
      authority: releaseAuthorityFixture,
      release: releaseFixture(incomplete),
    }).action, "skip");
  }
  for (const versions of [{}, { "@example/unrelated": "9.0.0" }]) {
    assert.equal(publicDocsReleaseQualificationDecision({
      authority: releaseAuthorityFixture,
      release: releaseFixture(versions),
    }).action, "skip");
  }
});

test("new stable target and its retry both require fail-closed public qualification", async () => {
  const release = releaseFixture({
    [releaseAuthorityFixture.packages.cli.name]: "0.5.0",
    [releaseAuthorityFixture.packages.mcp.name]: "0.2.0",
  });
  let qualifications = 0;
  const options = {
    inspectReleaseState: async () => release,
    loadAuthority: async () => releaseAuthorityFixture,
    qualify: async () => {
      qualifications += 1;
      return {
        coordinates: release.packages.public,
        matrix: ["npm-docs-only", "npm-docs-mcp", "pnpm-docs-only", "pnpm-docs-mcp"],
        missing: [],
        status: "ready",
      };
    },
    write: () => {},
  };
  assert.equal((await runPublicDocsReleaseQualification(options)).action, "require");
  assert.equal((await runPublicDocsReleaseQualification(options)).action, "require");
  assert.equal(qualifications, 2);
  for (const qualify of [
    async () => ({ coordinates: release.packages.public, missing: release.packages.public, status: "pending" }),
    async () => { throw new Error("qualification failed"); },
  ]) {
    await assert.rejects(runPublicDocsReleaseQualification({ ...options, qualify }),
      /Required public Docs Protocol coordinates are not available|qualification failed/u);
  }
});

test("exact target rejects when public coordinates remain pending", async () => {
  const release = releaseFixture(Object.fromEntries(
    Object.values(releaseAuthorityFixture.packages).map(({ name, version }) => [name, version]),
  ));
  await assert.rejects(runPublicDocsReleaseQualification({
    inspectReleaseState: async () => release,
    loadAuthority: async () => releaseAuthorityFixture,
    qualify: async () => ({
      coordinates: Object.values(releaseAuthorityFixture.packages),
      missing: Object.values(releaseAuthorityFixture.packages),
      status: "pending",
    }),
    write: () => {},
  }), /Required public Docs Protocol coordinates are not available/u);
});

function strictCompatibilityOptions(qualifyPublicDocs) {
  return {
    args: ["--require-public-docs"],
    qualifyPublicDocs,
    verifyAuthoring: async () => {},
    verifyBootstrap: async () => [],
    verifyScaffolding: async () => {},
    verifyTransactions: async () => {},
    write: () => {},
  };
}

function publicCompletionFixture({ refCommit = "a".repeat(40), missing = false, mutate } = {}) {
  return (input, options) => verifyPublicExactDocsCoordinates(input, {
    ...options,
    auditSignatures: async () => ({}),
    installAndQualify: async ({ temporaryRoot, matrixEntry }) => ({
      root: join(temporaryRoot, matrixEntry.id),
      userConfigPath: join(temporaryRoot, matrixEntry.id, "npmrc"),
    }),
    observePublishedPackages: async (coordinates) => publishedEvidence(coordinates, mutate),
    verifyGithub: (tag, commit, githubOptions) => verifyGithubTagRelease(tag, commit, {
      ...githubOptions,
      attempts: 1,
      request: (args) => {
        assert.equal(args.includes("--method"), false);
        if (missing) {
          return;
        }
        if (args[0].includes("/git/ref/tags/")) {
          return { object: { sha: refCommit, type: "commit" } };
        }
        if (args[0].includes("/releases/tags/")) {
          return { draft: false, prerelease: false, tag_name: tag };
        }
        throw new Error(`Unexpected route ${args[0]}`);
      },
    }),
    verifyProvenance: () => ({ commit: "a".repeat(40) }),
  });
}

test("strict compatibility and final release completion reject absent or wrong tags and SRI", async () => {
  const release = releaseFixture({
    [releaseAuthorityFixture.packages.cli.name]: "0.5.0",
    [releaseAuthorityFixture.packages.mcp.name]: "0.2.0",
  });
  const runFinal = (qualify) => runPublicDocsReleaseQualification({
    inspectReleaseState: async () => release,
    loadAuthority: async () => releaseAuthorityFixture,
    qualify,
    write: () => {},
  });
  for (const [scenario, expected] of [
    [{ missing: true }, /remained absent/u],
    [{ refCommit: "b".repeat(40) }, /Git tag is not bound/u],
    [{ mutate: (value) => ({ ...value, integrity: "sha512-invalid" }) }, /integrity/u],
    [{ mutate: (value) => ({ ...value, latest: "9.9.9" }) }, /latest dist-tag drifted/u],
  ]) {
    const qualify = publicCompletionFixture(scenario);
    await assert.rejects(runPublishedCompatibility(strictCompatibilityOptions(qualify)), expected);
    await assert.rejects(runFinal(qualify), expected);
  }
  const qualify = publicCompletionFixture();
  assert.equal((await runPublishedCompatibility(strictCompatibilityOptions(qualify))).publicDocs.status, "ready");
  assert.equal((await runFinal(qualify)).qualification.status, "ready");
});

test("strict compatibility requires available coordinates and propagates observation failures", async () => {
  await assert.rejects(runPublishedCompatibility(strictCompatibilityOptions(async (_input, options) => {
    assert.equal(options.observationAttempts, 5);
    return { missing: [], status: "pending" };
  })), /Required public Docs Protocol coordinates are not available/u);
  for (const message of ["HTTP 401", "HTTP 403", "network unavailable", "conflicting GitHub release", "invalid npm signature"]) {
    const failure = new Error(message);
    await assert.rejects(runPublishedCompatibility(strictCompatibilityOptions(async () => {
      throw failure;
    })), (error) => error === failure);
  }
});
