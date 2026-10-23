import { waitForBootstrapAvailability } from "../scripts/npm-package-bootstrap-registry.mjs";
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

import {
  name,
  version,
  sourceCommit,
  archiveIntegrity,
  changedArchiveIntegrity,
  predecessor,
  successorCatalog,
  packageCatalog,
  releaseState,
  generatedReleaseState,
  changesetPlan,
  statement,
  auditEvidence,
  packument,
  verifyFixture,
  type Provenance,
  type Predecessor,
  type CatalogProfile,
  type MutableCatalog,
} from "./support/npm-bootstrap-successor-fixtures.ts";

async function runCli(releaseVersion: string, metadata = packument(), status = 200) {
  let output = "";
  await runNpmPackageBootstrapCli(["check-release"], {
    auditPackage: async () => auditEvidence(),
    catalog: successorCatalog(),
    collectPlannedReleaseVersions: async () => ({ [name]: releaseVersion }),
    fetchImplementation: async () =>
      new Response(status === 200 ? JSON.stringify(metadata) : "not found", { status }),
    observationOptions: { attempts: 1, wait: async () => {} },
    readManifest: async () => ({ name, version }),
    writeOutput: (value: string) => {
      output += value;
    },
  });
  return output;
}

void test("catalog pins the exact published RC predecessor identity", () => {
  const profile = successorCatalog().packages[0];
  assert.deepEqual(profile.releasePredecessor, predecessor);
  assert.deepEqual(profile.approval, {
    archiveIntegrity:
      "sha512-TfvqvgodFFHk8ZuM9rRByn+2WQIrL/lw08s7XlqzI8Ww1O9DU5S9cpaggylbmUjbyiqm7T2itDBmEF33C8DO4A==",
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
    [
      "archiveIntegrity",
      { ...structuredClone(predecessor), archiveIntegrity: changedArchiveIntegrity },
    ],
    [
      "provenance ref",
      {
        ...structuredClone(predecessor),
        provenance: { ...predecessor.provenance, ref: "refs/heads/release" },
      },
    ],
    [
      "provenance repository",
      {
        ...structuredClone(predecessor),
        provenance: {
          ...predecessor.provenance,
          repository: "https://github.com/agent-teams-ai/other",
        },
      },
    ],
    [
      "provenance sourceCommit",
      {
        ...structuredClone(predecessor),
        provenance: { ...predecessor.provenance, sourceCommit: "2".repeat(40) },
      },
    ],
    [
      "provenance workflowPath",
      {
        ...structuredClone(predecessor),
        provenance: { ...predecessor.provenance, workflowPath: ".github/workflows/release.yml" },
      },
    ],
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
    [
      "missing archive",
      (profile) => {
        delete (profile.releasePredecessor as Partial<Predecessor>).archiveIntegrity;
      },
    ],
    [
      "missing source",
      (profile) => {
        const mutablePredecessor = profile.releasePredecessor!;
        delete (mutablePredecessor.provenance as Partial<Provenance>).sourceCommit;
      },
    ],
    [
      "name",
      (profile) => {
        profile.releasePredecessor!.name = "@agent-teams/other-package";
      },
    ],
    [
      "version",
      (profile) => {
        profile.releasePredecessor!.version = "0.1.0-rc.1";
      },
    ],
    [
      "archive",
      (profile) => {
        profile.releasePredecessor!.archiveIntegrity = changedArchiveIntegrity;
      },
    ],
    [
      "source",
      (profile) => {
        profile.releasePredecessor!.provenance.sourceCommit = "2".repeat(40);
      },
    ],
    [
      "workflow",
      (profile) => {
        profile.releasePredecessor!.provenance.workflowPath = ".github/workflows/release.yml";
      },
    ],
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
    assert.deepEqual(await verifyFixture({ metadata: packument(archiveIntegrity, null), mode }), [
      `${name}@${version}`,
    ]);
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
      () =>
        verifyFixture({
          metadata: { versions: {}, "dist-tags": {} },
          mode,
          releaseVersion: "0.1.0",
        }),
      /predecessor is absent/u,
    );
    await assert.rejects(
      () =>
        verifyFixture({
          metadata: packument(changedArchiveIntegrity),
          mode,
          releaseVersion: "0.1.0",
        }),
      /predecessor archive SRI differs/u,
    );
    await assert.rejects(
      () =>
        verifyFixture({
          audit: auditEvidence(statement(undefined, undefined, changedArchiveIntegrity)),
          mode,
          releaseVersion: "0.1.0",
        }),
      /not bound/u,
    );
    await assert.rejects(
      () =>
        verifyFixture({
          audit: auditEvidence(statement(undefined, "2".repeat(40))),
          mode,
          releaseVersion: "0.1.0",
        }),
      /source commit differs from reviewed provenance/u,
    );
    await assert.rejects(
      () =>
        verifyFixture({
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
    assert.doesNotThrow(() => {
      assertBootstrapReleasePolicy(releaseState(name, releaseVersion), registry, catalog);
    }, releaseVersion);
    assert.deepEqual(await verifyFixture({ mode: "direct", releaseVersion }), [
      `${name}@${version}`,
    ]);
    assert.deepEqual(await verifyFixture({ mode: "releaseState", releaseVersion }), [
      `${name}@${version}`,
    ]);
  }
  await assert.rejects(
    () =>
      verifyReleaseBootstrapBaselines({
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
  assert.deepEqual(
    await verifyLiveBootstrapBaselines({
      auditPackage: async () => {
        throw new Error("unchanged source must not audit a baseline");
      },
      catalog,
      fetchImplementation: async () => {
        throw new Error("unchanged source must not read a baseline");
      },
      readManifest: async () => ({ name, version: "0.0.0" }),
    }),
    [],
  );
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
  assert.deepEqual(
    await verifyReleaseBootstrapBaselines({
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
    }),
    [],
  );
  assert.equal(collectionCalled, false);
});

void test("the Changesets plan collector drives the actual pre-version CLI guard", async () => {
  const plan = changesetPlan(name, "0.1.0");
  assert.deepEqual(plannedReleaseVersions(plan), { [name]: "0.1.0" });
  const unchanged = {
    changesets: [],
    releases: [{ name, type: "none", oldVersion: "1.0.0", newVersion: "1.0.0", changesets: [] }],
  };
  assert.deepEqual(plannedReleaseVersions(unchanged), { [name]: "1.0.0" });
  assert.throws(
    () =>
      plannedReleaseVersions({
        ...unchanged,
        releases: [{ ...unchanged.releases[0], newVersion: "1.0.1" }],
      }),
    /Changesets release/u,
  );

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
      delete (value.releases[0] as Partial<(typeof value.releases)[number]>).newVersion;
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

  await assert.rejects(() => runCli("0.0.0"), /0\.0\.0 baseline is (?:absent|missing)/u);
  assert.equal(
    await runCli("0.1.0"),
    `Verified required npm bootstrap baselines: ${name}@${version}.\n`,
  );
  await assert.rejects(() => runCli("0.1.0", packument(), 404), /predecessor is absent/u);
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
    verifyBootstrapBaselines: (options) =>
      verifyReleaseBootstrapBaselines({
        ...options,
        auditPackage: async () => auditEvidence(),
        catalog: successorCatalog(),
        fetchImplementation: async () => new Response(JSON.stringify(packument()), { status: 200 }),
        observationOptions: { attempts: 1, wait: async () => {} },
      }),
  });
  assert.equal(published, 1);
  assert.deepEqual(
    assertBootstrapRegistryVersionHistory(successorCatalog().packages[0], ["0.0.0-stage", version]),
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
    () =>
      runReleasePublish({
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

void test("successor audit availability binds the reviewed RC instead of the old bootstrap SRI", async () => {
  let observedIntegrity: string | undefined;
  const options = {
    catalog: successorCatalog(),
    readManifest: async () => ({ name, version: "0.2.0" }),
    observationOptions: { attempts: 1, wait: async () => {} },
    fetchImplementation: async () => new Response(JSON.stringify(packument())),
    auditPackage: async (profile: {
      name: string;
      bootstrapVersion: string;
      approval: { archiveIntegrity: string } | null;
    }) => {
      observedIntegrity = profile.approval?.archiveIntegrity;
      await waitForBootstrapAvailability(profile, {
        fetchImplementation: async () =>
          new Response(
            JSON.stringify({
              name,
              version,
              dist: { integrity: archiveIntegrity },
            }),
          ),
      });
      return auditEvidence();
    },
  };
  await verifyLiveBootstrapBaselines(options);
  assert.equal(observedIntegrity, archiveIntegrity);
  const oldApproval = successorCatalog().packages[0].approval;
  assert.ok(oldApproval !== null);
  assert.notEqual(archiveIntegrity, oldApproval.archiveIntegrity);
});
