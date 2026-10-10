import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  NPM_PACKAGE_BOOTSTRAP,
  assertBootstrapRegistryVersionHistory,
  assertBootstrapReleasePolicy,
  assertPredecessorInventory,
  parseBootstrapCatalog,
  verifyLiveBootstrapBaselines,
  verifyReleaseBootstrapBaselines,
} from "../scripts/npm-package-bootstrap.mjs";
import { main as runNpmPackageBootstrapCli } from "../scripts/npm-package-bootstrap-cli.mjs";
import {
  collectPlannedReleaseVersions,
  plannedReleaseVersions,
} from "../scripts/npm-package-bootstrap-release-plan.mts";
import { main as runReleasePublish } from "../scripts/release-publish.mjs";

type Provenance = {
  ref: string;
  repository: string;
  sourceCommit: string;
  workflowPath: string;
};
type Predecessor = {
  archiveIntegrity: string;
  name: string;
  provenance: Provenance;
  version: string;
};
type CatalogProfile = {
  approval: { archiveIntegrity: string; packageTree: string } | null;
  bootstrapVersion: string;
  id: string;
  name: string;
  provenance: Provenance;
  releasePredecessor: Predecessor | null;
  state: string;
};
type MutableCatalog = { packages: Array<CatalogProfile & Record<string, unknown>> };
type ParsedCatalog = {
  packages: readonly CatalogProfile[];
  registry: string;
  repository: string;
  schemaVersion: number;
};
type PackumentVersion = {
  dist: { integrity: string };
  gitHead?: string | null;
};
type Packument = {
  versions: Record<string, PackumentVersion>;
  "dist-tags": Record<string, string>;
};
type ProvenanceStatement = {
  _type: string;
  predicate: {
    buildDefinition: {
      externalParameters: {
        workflow: { path: string; ref: string; repository: string };
      };
      resolvedDependencies: Array<{ digest: { gitCommit: string }; uri: string }>;
    };
  };
  predicateType: string;
  subject: Array<{ digest: { sha512: string }; name: string }>;
};

const name = "@agent-teams/ci-input-proof";
const version = "0.1.0-rc.0";
const sourceCommit = "598c248b56d134a9fd1dcd86417a2c93538ef65d";
const archiveIntegrity =
  "sha512-aiOC4nvGRfG6CkLKRG2utkqFAOJNtPojZZYLqmmG5OzhZYKqQCh6T2OOMNqA5vlbccWWEXxismMXE6QDl0vo7w==";
const changedArchiveIntegrity =
  "sha512-TfvqvgodFFHk8ZuM9rRByn+2WQIrL/lw08s7XlqzI8Ww1O9DU5S9cpaggylbmUjbyiqm7T2itDBmEF33C8DO4A==";
const predecessor: Predecessor = {
  archiveIntegrity,
  name,
  provenance: {
    ref: "refs/heads/main",
    repository: "https://github.com/agent-teams-ai/engineering-foundation",
    sourceCommit,
    workflowPath: ".github/workflows/ci-input-proof-rc.yml",
  },
  version,
};

function successorCatalog(): ParsedCatalog {
  const value = structuredClone(NPM_PACKAGE_BOOTSTRAP) as unknown as MutableCatalog;
  value.packages = value.packages.filter((entry) => entry.id === "ci-input-proof");
  const parsed: unknown = parseBootstrapCatalog(value);
  return parsed as ParsedCatalog;
}

function packageCatalog(id: string): ParsedCatalog {
  const value = structuredClone(NPM_PACKAGE_BOOTSTRAP) as unknown as MutableCatalog;
  value.packages = value.packages.filter((entry) => entry.id === id);
  const parsed: unknown = parseBootstrapCatalog(value);
  return parsed as ParsedCatalog;
}

function releaseState(packageName: string, packageVersion: string) {
  return {
    packages: {
      private: [],
      public: [{
        manifestBytes: JSON.stringify({ name: packageName, version: packageVersion }),
        name: packageName,
        version: packageVersion,
      }],
    },
  };
}

function generatedReleaseState(packageName: string, packageVersion: string) {
  return {
    controlFiles: [],
    inventory: {
      files: [],
      metadata: ["README.md", "config.json"],
      pending: [],
      unexpected: [],
    },
    packages: {
      private: [],
      public: [{
        manifestBytes: JSON.stringify({ name: packageName, version: packageVersion }),
        name: packageName,
        registry: "https://registry.npmjs.org/",
        required: false,
        version: packageVersion,
      }],
    },
    preState: undefined,
  };
}

function changesetPlan(packageName: string, newVersion: string) {
  return {
    changesets: [{
      id: "ci-input-proof-kernel",
      releases: [{ name: packageName, type: "minor" }],
      summary: "Add the reviewed successor.",
    }],
    releases: [{
      changesets: ["ci-input-proof-kernel"],
      name: packageName,
      newVersion,
      oldVersion: "0.1.0-rc.0",
      type: "minor",
    }],
    preState: undefined,
  };
}

function statement(
  workflowPath = predecessor.provenance.workflowPath,
  commit = predecessor.provenance.sourceCommit,
  integrity = archiveIntegrity,
): ProvenanceStatement {
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            path: workflowPath,
            ref: predecessor.provenance.ref,
            repository: predecessor.provenance.repository,
          },
        },
        resolvedDependencies: [{
          digest: { gitCommit: commit },
          uri: `git+${predecessor.provenance.repository}@${predecessor.provenance.ref}`,
        }],
      },
    },
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{
      digest: {
        sha512: Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex"),
      },
      name: "pkg:npm/%40agent-teams/ci-input-proof@0.1.0-rc.0",
    }],
  };
}

function auditEvidence(value: ProvenanceStatement = statement()) {
  return {
    invalid: [],
    missing: [],
    verified: [{
      attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
      attestationBundles: [{
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(value)).toString("base64"),
            payloadType: "application/vnd.in-toto+json",
          },
        },
        predicateType: "https://slsa.dev/provenance/v1",
      }, {
        predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
      }],
      name,
      version,
    }],
  };
}

function packument(integrity = archiveIntegrity, gitHead?: string | null): Packument {
  const published: PackumentVersion = { dist: { integrity } };
  if (gitHead !== undefined) {
    published.gitHead = gitHead;
  }
  return {
    versions: {
      "0.0.0-stage": { dist: { integrity: changedArchiveIntegrity } },
      [version]: published,
    },
    "dist-tags": { latest: version, rc: version },
  };
}

async function verifyFixture({
  audit = auditEvidence(),
  metadata = packument(),
  mode = "releaseState",
  releaseVersion = "0.2.0",
  status = 200,
}: {
  audit?: ReturnType<typeof auditEvidence>;
  metadata?: Packument;
  mode?: "direct" | "releaseState";
  releaseVersion?: string;
  status?: number;
} = {}) {
  const options = {
    auditPackage: async () => audit,
    catalog: successorCatalog(),
    fetchImplementation: async () => new Response(
      status === 200 ? JSON.stringify(metadata) : "not found",
      { status },
    ),
    observationOptions: { attempts: 1, wait: async () => {} },
    readManifest: async () => ({ name, version: releaseVersion }),
    temporaryRoot: undefined,
  };
  return await (mode === "direct"
    ? verifyLiveBootstrapBaselines(options)
    : verifyReleaseBootstrapBaselines({
      ...options,
      readManifest: async () => {
        throw new Error("releaseState must supply the manifest");
      },
      releaseState: releaseState(name, releaseVersion),
    }));
}

void test("catalog pins the exact published RC predecessor identity", () => {
  const profile = successorCatalog().packages[0];
  assert.deepEqual(profile.releasePredecessor, predecessor);
  assert.deepEqual(profile.approval, {
    archiveIntegrity: "sha512-TfvqvgodFFHk8ZuM9rRByn+2WQIrL/lw08s7XlqzI8Ww1O9DU5S9cpaggylbmUjbyiqm7T2itDBmEF33C8DO4A==",
    packageTree: "7f534b4e0323045535fd9024d70e7e1d2ac63b3c",
  });
  assert.equal(profile.bootstrapVersion, "0.0.0");
});

void test("pure predecessor comparison accepts only the exact complete inventory", () => {
  assert.deepEqual(
    assertPredecessorInventory(predecessor, structuredClone(predecessor)),
    predecessor,
  );

  const missing = structuredClone(predecessor) as Record<string, unknown>;
  delete missing.archiveIntegrity;
  assert.throws(
    () => assertPredecessorInventory(missing, structuredClone(predecessor)),
    /unexpected inventory shape/u,
  );

  const changed: Array<[string, Record<string, unknown>]> = [
    ["name", { ...structuredClone(predecessor), name: "@agent-teams/other-package" }],
    ["version", { ...structuredClone(predecessor), version: "0.1.0-rc.1" }],
    ["archiveIntegrity", { ...structuredClone(predecessor), archiveIntegrity: changedArchiveIntegrity }],
    ["provenance ref", {
      ...structuredClone(predecessor),
      provenance: { ...predecessor.provenance, ref: "refs/heads/release" },
    }],
    ["provenance repository", {
      ...structuredClone(predecessor),
      provenance: { ...predecessor.provenance, repository: "https://github.com/agent-teams-ai/other" },
    }],
    ["provenance sourceCommit", {
      ...structuredClone(predecessor),
      provenance: { ...predecessor.provenance, sourceCommit: "2".repeat(40) },
    }],
    ["provenance workflowPath", {
      ...structuredClone(predecessor),
      provenance: { ...predecessor.provenance, workflowPath: ".github/workflows/release.yml" },
    }],
  ];
  for (const [label, observed] of changed) {
    assert.throws(
      () => assertPredecessorInventory(predecessor, observed),
      /predecessor (name|version|archiveIntegrity|provenance)/u,
      label,
    );
  }
});

void test("catalog rejects missing or changed reviewed predecessor authority", () => {
  const mutations: Array<[string, (profile: CatalogProfile & Record<string, unknown>) => void]> = [
    ["missing archive", (profile) => {
      delete (profile.releasePredecessor as Partial<Predecessor>).archiveIntegrity;
    }],
    ["missing source", (profile) => {
      const mutablePredecessor = profile.releasePredecessor!;
      delete (mutablePredecessor.provenance as Partial<Provenance>).sourceCommit;
    }],
    ["name", (profile) => {
      profile.releasePredecessor!.name = "@agent-teams/other-package";
    }],
    ["version", (profile) => {
      profile.releasePredecessor!.version = "0.1.0-rc.1";
    }],
    ["archive", (profile) => {
      profile.releasePredecessor!.archiveIntegrity = changedArchiveIntegrity;
    }],
    ["source", (profile) => {
      profile.releasePredecessor!.provenance.sourceCommit = "2".repeat(40);
    }],
    ["workflow", (profile) => {
      profile.releasePredecessor!.provenance.workflowPath = ".github/workflows/release.yml";
    }],
  ];
  for (const [label, mutate] of mutations) {
    const value = structuredClone(NPM_PACKAGE_BOOTSTRAP) as unknown as MutableCatalog;
    value.packages = value.packages.filter((entry) => entry.id === "ci-input-proof");
    mutate(value.packages[0]);
    assert.throws(() => parseBootstrapCatalog(value), /predecessor/iu, label);
  }
});

void test("verification accepts absent or matching npm gitHead and rejects a contradiction", async () => {
  for (const mode of ["direct", "releaseState"] as const) {
    assert.deepEqual(await verifyFixture({ mode }), [`${name}@${version}`]);
    assert.deepEqual(
      await verifyFixture({ metadata: packument(archiveIntegrity, null), mode }),
      [`${name}@${version}`],
    );
    assert.deepEqual(
      await verifyFixture({ metadata: packument(archiveIntegrity, sourceCommit), mode }),
      [`${name}@${version}`],
    );
    await assert.rejects(
      () => verifyFixture({ metadata: packument(archiveIntegrity, "2".repeat(40)), mode }),
      /npm gitHead contradicts signed provenance/u,
    );
  }
});

void test("verification rejects missing, wrong-SRI, and wrong-source predecessor evidence", async () => {
  for (const mode of ["direct", "releaseState"] as const) {
    await assert.rejects(
      () => verifyFixture({ mode, releaseVersion: "0.1.0", status: 404 }),
      /predecessor is absent/u,
    );
    await assert.rejects(
      () => verifyFixture({
        metadata: { versions: {}, "dist-tags": {} },
        mode,
        releaseVersion: "0.1.0",
      }),
      /predecessor is absent/u,
    );
    await assert.rejects(
      () => verifyFixture({
        metadata: packument(changedArchiveIntegrity),
        mode,
        releaseVersion: "0.1.0",
      }),
      /predecessor archive SRI differs/u,
    );
    await assert.rejects(
      () => verifyFixture({
        audit: auditEvidence(statement(undefined, undefined, changedArchiveIntegrity)),
        mode,
        releaseVersion: "0.1.0",
      }),
      /not bound/u,
    );
    await assert.rejects(
      () => verifyFixture({
        audit: auditEvidence(statement(undefined, "2".repeat(40))),
        mode,
        releaseVersion: "0.1.0",
      }),
      /source commit differs from reviewed provenance/u,
    );
    await assert.rejects(
      () => verifyFixture({
        audit: auditEvidence(statement(".github/workflows/release.yml")),
        mode,
        releaseVersion: "0.1.0",
      }),
      /not bound/u,
    );
  }
});

void test("old 0.0.0 failure remains while ordinary later successors use the RC baseline", async () => {
  const catalog = successorCatalog();
  const registry = [{ name, versions: [version] }];
  for (const releaseVersion of ["0.0.0", "0.0.0-stage", "0.0.1", version]) {
    assert.throws(
      () => {
        assertBootstrapReleasePolicy(releaseState(name, releaseVersion), registry, catalog);
      },
      /immutable 0\.0\.0 npm baseline/u,
      releaseVersion,
    );
  }
  for (const releaseVersion of ["0.1.0", "0.2.0", "0.3.0", "1.0.0"]) {
    assert.doesNotThrow(
      () => {
        assertBootstrapReleasePolicy(releaseState(name, releaseVersion), registry, catalog);
      },
      releaseVersion,
    );
    assert.deepEqual(await verifyFixture({ mode: "direct", releaseVersion }), [`${name}@${version}`]);
    assert.deepEqual(await verifyFixture({ mode: "releaseState", releaseVersion }), [`${name}@${version}`]);
  }
  await assert.rejects(
    () => verifyReleaseBootstrapBaselines({
      auditPackage: async () => {
        throw new Error("old baseline audit must not run");
      },
      catalog,
      fetchImplementation: async () => new Response("not found", { status: 404 }),
      observationOptions: { attempts: 1, wait: async () => {} },
      readManifest: async () => ({ name, version: "0.0.0" }),
      releaseState: releaseState(name, "0.0.0"),
    }),
    /baseline is absent/u,
  );
  const oldBaselineOptions = {
    auditPackage: async () => {
      throw new Error("old baseline audit must not run");
    },
    catalog,
    fetchImplementation: async () => new Response("not found", { status: 404 }),
    observationOptions: { attempts: 1, wait: async () => {} },
    readManifest: async () => ({ name, version: "0.0.0" }),
    requireAllBaselines: true,
  };
  await assert.rejects(
    () => verifyLiveBootstrapBaselines(oldBaselineOptions),
    /baseline is absent/u,
  );
  assert.deepEqual(await verifyLiveBootstrapBaselines({
    auditPackage: async () => {
      throw new Error("unchanged source must not audit a baseline");
    },
    catalog,
    fetchImplementation: async () => {
      throw new Error("unchanged source must not read a baseline");
    },
    readManifest: async () => ({ name, version: "0.0.0" }),
  }), []);
});

void test("the successor baseline exception is immune to unrelated package releases", async () => {
  const unrelatedName = "@agent-teams/repository-mutation";
  assert.doesNotThrow(() => {
    assertBootstrapReleasePolicy(
      releaseState(unrelatedName, "0.2.0"),
      [{ name: unrelatedName, versions: ["0.0.0"] }],
      packageCatalog("repository-mutation"),
    );
  });

  let collectionCalled = false;
  assert.deepEqual(await verifyReleaseBootstrapBaselines({
    auditPackage: async () => {
      collectionCalled = true;
      throw new Error("unexpected predecessor collection");
    },
    catalog: successorCatalog(),
    fetchImplementation: async () => {
      collectionCalled = true;
      throw new Error("unexpected predecessor read");
    },
    readManifest: async () => ({ name: unrelatedName, version: "0.0.0" }),
    releaseState: releaseState(unrelatedName, "0.0.0"),
  }), []);
  assert.equal(collectionCalled, false);
});

void test("the Changesets plan collector drives the actual pre-version CLI guard", async () => {
  const plan = changesetPlan(name, "0.1.0");
  assert.deepEqual(plannedReleaseVersions(plan), { [name]: "0.1.0" });

  let outputPath = "";
  const collected = await collectPlannedReleaseVersions({
    cwd: "/TEST-consumer",
    runChangesetStatus: async (cwd, output) => {
      assert.equal(cwd, "/TEST-consumer");
      outputPath = output;
      await writeFile(output, `${JSON.stringify(plan)}\n`, "utf8");
    },
    temporaryRoot: process.env.TMPDIR,
  });
  assert.deepEqual(collected, { [name]: "0.1.0" });
  await assert.rejects(() => readFile(outputPath, "utf8"), { code: "ENOENT" });

  for (const mutate of [
    (value: ReturnType<typeof changesetPlan>) => {
      delete (value.releases[0] as Partial<typeof value.releases[number]>).newVersion;
    },
    (value: ReturnType<typeof changesetPlan>) => {
      value.releases[0].newVersion = "";
    },
    (value: ReturnType<typeof changesetPlan>) => {
      value.releases.push({ ...value.releases[0] });
    },
  ]) {
    const changed = structuredClone(plan);
    mutate(changed);
    assert.throws(() => plannedReleaseVersions(changed), /Changesets release/u);
  }

  const runCli = async (releaseVersion: string, metadata = packument(), status = 200) => {
    let output = "";
    await runNpmPackageBootstrapCli(["check-release"], {
      auditPackage: async () => auditEvidence(),
      catalog: successorCatalog(),
      collectPlannedReleaseVersions: async () => ({ [name]: releaseVersion }),
      fetchImplementation: async () => new Response(
        status === 200 ? JSON.stringify(metadata) : "not found",
        { status },
      ),
      observationOptions: { attempts: 1, wait: async () => {} },
      readManifest: async () => ({ name, version }),
      writeOutput: (value: string) => {
        output += value;
      },
    });
    return output;
  };

  await assert.rejects(
    () => runCli("0.0.0"),
    /0\.0\.0 baseline is (?:absent|missing)/u,
  );
  assert.equal(
    await runCli("0.1.0"),
    `Verified required npm bootstrap baselines: ${name}@${version}.\n`,
  );
  await assert.rejects(
    () => runCli("0.1.0", packument(), 404),
    /predecessor is absent/u,
  );
  await assert.rejects(
    () => runCli("0.1.0", packument(changedArchiveIntegrity)),
    /predecessor archive SRI differs/u,
  );
  await assert.rejects(
    () => runCli("0.1.0", packument(archiveIntegrity, "2".repeat(40))),
    /npm gitHead contradicts signed provenance/u,
  );
});

void test("the actual publish entrypoint accepts exact stage-plus-RC history and rejects foreign stage history", async () => {
  const state = generatedReleaseState(name, "0.1.0");
  let published = 0;
  await runReleasePublish({
    bootstrapCatalog: successorCatalog(),
    inspectReleaseState: async () => state,
    publishOrdered: async () => {
      published += 1;
    },
    registryMetadata: async () => ({
      distTags: { latest: version, rc: version },
      exists: true,
      versions: ["0.0.0-stage", version],
    }),
    verifyBootstrapBaselines: (options) => verifyReleaseBootstrapBaselines({
      ...options,
      auditPackage: async () => auditEvidence(),
      catalog: successorCatalog(),
      fetchImplementation: async () => new Response(JSON.stringify(packument()), { status: 200 }),
      observationOptions: { attempts: 1, wait: async () => {} },
    }),
  });
  assert.equal(published, 1);
  assert.deepEqual(
    assertBootstrapRegistryVersionHistory(
      successorCatalog().packages[0],
      ["0.0.0-stage", version],
    ),
    [version],
  );

  const unrelated = packageCatalog("repository-mutation");
  const unrelatedName = unrelated.packages[0].name;
  const unrelatedState = generatedReleaseState(unrelatedName, "0.2.0");
  let unrelatedPublished = 0;
  await runReleasePublish({
    bootstrapCatalog: unrelated,
    inspectReleaseState: async () => unrelatedState,
    publishOrdered: async () => {
      unrelatedPublished += 1;
    },
    registryMetadata: async () => ({
      distTags: { latest: "0.0.0" },
      exists: true,
      versions: ["0.0.0"],
    }),
    verifyBootstrapBaselines: async () => [],
  });
  assert.equal(unrelatedPublished, 1);

  await assert.rejects(
    () => runReleasePublish({
      bootstrapCatalog: unrelated,
      inspectReleaseState: async () => unrelatedState,
      publishOrdered: async () => {
        throw new Error("foreign stage history must not publish");
      },
      registryMetadata: async () => ({
        distTags: { latest: "0.0.0" },
        exists: true,
        versions: ["0.0.0-stage", "0.0.0"],
      }),
      verifyBootstrapBaselines: async () => [],
    }),
    /contains an unsupported version/u,
  );
});
