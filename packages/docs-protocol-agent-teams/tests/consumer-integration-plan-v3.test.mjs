import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  BOOTSTRAP_KNOWN_PRIOR_DOCS_SKILLS,
  CANONICAL_DOCS_SKILL_V2,
  canonicalCallerWorkflow,
  canonicalDocsScriptsDigest,
  describeCanonicalConsumerAssets
} from "../dist/consumer-integration/application/policies/consumer-integration-assets.js";
import {
  compileConsumerIntegration
} from "../dist/consumer-integration/application/use-cases/plan-consumer-integration.js";

const INTEGRITY = `sha512-${"A".repeat(86)}==`;
const absent = Object.freeze({ state: "absent" });
const file = (value) => ({ state: "file", bytes: Buffer.from(value), mode: 0o644 });
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("portable Skill evolution preserves historical bootstrap bytes and six-script custody", () => {
  assert.deepEqual(BOOTSTRAP_KNOWN_PRIOR_DOCS_SKILLS.map(digest), [
    "sha256:7b31cd257532247f64c55a014dc926c601e4d742176cfb8513b6b0d8ab48213e",
    "sha256:d56716113038dc7b8335aed11ccf258123d976e036dec17fc9afcca920e199a5"
  ]);
  assert.equal(canonicalDocsScriptsDigest("architecture/foundation/docs-protocol.yaml"),
    "sha256:7a502ddeda5e3d0296b712b5c07e0905a9b7a8fcd374d37db8a02cb026a37881");
});

function desired() {
  const provisional = {
    schemaVersion: 2,
    cohortId: "docs-2026-09-v2",
    channel: "rc",
    recordDigest: `sha256:${"1".repeat(64)}`,
    qualificationEventDigest: `sha256:${"2".repeat(64)}`,
    eligibleAfter: "2026-09-04T00:00:00Z",
    upgradeFrom: ["docs-2026-08-v1"],
    rollbackTo: ["docs-2026-08-v1"],
    packages: {
      repositoryMutation: { version: "0.1.0", integrity: INTEGRITY },
      documentAuthoring: { version: "0.1.0", integrity: INTEGRITY },
      docsProtocol: { version: "0.5.0", integrity: INTEGRITY },
      docsProtocolAgentTeams: { version: "0.1.0", integrity: INTEGRITY },
      engineeringFoundation: { version: "1.0.0", integrity: INTEGRITY }
    },
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: "3".repeat(40),
      blobSha: "4".repeat(40)
    },
    assets: {
      skillDigest: `sha256:${"5".repeat(64)}`,
      callerWorkflowDigest: `sha256:${"6".repeat(64)}`,
      assetCatalogDigest: `sha256:${"7".repeat(64)}`,
      transitionCatalogDigest: `sha256:${"8".repeat(64)}`
    },
    schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 },
    runtime: {
      node: ">=24.18.0 <25",
      pnpm: ">=11.17.0 <12",
      runtimeClosureDigest: `sha256:${"9".repeat(64)}`
    }
  };
  return {
    schemaVersion: 3,
    repository: {
      provider: "github",
      id: "1314129620",
      nameWithOwner: "agent-teams-ai/agent-runtime"
    },
    integrationRoot: ".",
    packageManager: "pnpm",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    qualification: {
      contractPath: "architecture/foundation/docs-protocol-qualification.json",
      gateCommand: "pnpm docs:protocol:check"
    },
    cohort: { ...provisional, assets: describeCanonicalConsumerAssets(provisional) }
  };
}

function snapshot() {
  return {
    integrationProfile: file("profile\n"),
    lockfile: file("lockfile\n"),
    packageManifest: file("{}\n"),
    agents: file("# Agents\n"),
    skill: absent,
    callerWorkflow: absent,
    managedState: absent
  };
}

function ports(observedSchemas) {
  return {
    packageManifest: {
      plan(input) {
        observedSchemas.push(input.cohort.schemaVersion);
        const currentDigest = digest(input.observation.bytes);
        return {
          state: "exact-current",
          currentDigest,
          expectedDigest: currentDigest,
          issues: []
        };
      }
    },
    agentsRoute: {
      plan(input) {
        const currentDigest = digest(input.observation.bytes);
        return {
          state: "exact-current",
          currentDigest,
          expectedDigest: currentDigest,
          issues: []
        };
      }
    }
  };
}

function applyFullAssetOperations(current, compiled) {
  const next = { ...current };
  for (const operation of compiled.mutationPlan.operations) {
    const observation = file(Buffer.from(operation.postimage.contentBase64, "base64"));
    if (operation.path.endsWith("SKILL.md")) {next.skill = observation;}
    if (operation.path.endsWith("docs-protocol.yml")) {next.callerWorkflow = observation;}
    if (operation.path.endsWith("docs-protocol-managed-state.json")) {
      next.managedState = observation;
    }
  }
  return next;
}

test("profile v3 plans only canonical new assets and accepts exact managed-state v2", () => {
  const target = desired();
  const schemas = [];
  const initial = snapshot();
  const compiled = compileConsumerIntegration(
    { desired: target, snapshot: initial },
    ports(schemas)
  );

  assert.deepEqual(schemas, [2]);
  assert.equal(compiled.plan.outcome, "change-required");
  assert.equal(compiled.plan.issues.length, 0);
  assert.deepEqual(
    compiled.plan.assets.filter(({ action }) => action === "create").map(({ id }) => id).toSorted(),
    ["caller-workflow", "managed-state", "skill"]
  );

  const current = applyFullAssetOperations(initial, compiled);
  const second = compileConsumerIntegration(
    { desired: target, snapshot: current },
    ports([])
  );
  assert.equal(second.plan.outcome, "current");
  assert.equal(second.mutationPlan.operations.length, 0);
  const managed = JSON.parse(Buffer.from(current.managedState.bytes).toString("utf8"));
  assert.equal(managed.schemaVersion, 2);
  assert.deepEqual(
    Object.keys(managed.packages).toSorted(),
    Object.keys(target.cohort.packages).toSorted()
  );
  assert.equal(Buffer.from(current.skill.bytes).toString("utf8"), CANONICAL_DOCS_SKILL_V2);
  assert.equal(
    Buffer.from(current.callerWorkflow.bytes).toString("utf8"),
    canonicalCallerWorkflow(target.cohort)
  );
});

test("profile v3 blocks modified managed bytes, forged asset digests, and V1 catalogs", () => {
  const target = desired();
  const modified = snapshot();
  modified.managedState = file("{\"locallyModified\":true}\n");
  const blocked = compileConsumerIntegration(
    { desired: target, snapshot: modified },
    ports([])
  );
  assert.equal(blocked.plan.outcome, "blocked");
  assert.equal(blocked.mutationPlan, undefined);
  assert.ok(blocked.plan.issues.some(({ code, subject }) =>
    code === "DOCS_CONSUMER_UNKNOWN_MANAGED_ASSET" && subject === target.managedStatePath
  ));

  const forged = {
    ...target,
    cohort: {
      ...target.cohort,
      assets: { ...target.cohort.assets, skillDigest: `sha256:${"a".repeat(64)}` }
    }
  };
  const mismatch = compileConsumerIntegration(
    { desired: forged, snapshot: snapshot() },
    ports([])
  );
  assert.equal(mismatch.plan.outcome, "blocked");
  assert.ok(mismatch.plan.issues.some(({ code }) =>
    code === "DOCS_CONSUMER_COHORT_ASSET_MISMATCH"
  ));

  assert.throws(
    () => compileConsumerIntegration(
      { desired: target, snapshot: snapshot(), knownPriorCohorts: [] },
      ports([])
    ),
    /does not accept V1 asset catalogs/u
  );
});

test("unknown desired input retains closed generations and bounded plain-data validation", async () => {
  const { assertConsumerIntegrationDesiredStateV3 } = await import(
    "../dist/consumer-integration/application/policies/consumer-integration-desired-state.js"
  );
  for (const mutate of [
    (v) => {v.schemaVersion = 4;},
    (v) => {v.packageManager = "npm";},
    (v) => {v.repository.provider = "gitlab";},
    (v) => {v.repository.id = 123;},
    (v) => {v.qualification.gateCommand = "pnpm arbitrary";},
    (v) => {v.cohort.schemaVersion = 1;},
    (v) => {v.cohort.schemas.managedState = 1;},
    (v) => {v.cohort.schemas.consumerIntegration = 4;},
    (v) => {v.cohort.runtime.node = "*";},
    (v) => {v.cohort.channel = "latest";},
    (v) => {v.cohort.packages.repositoryMutation.version = 1;},
    (v) => {v.cohort.packages.extra = {};},
    (v) => {v.cohort.upgradeFrom = [null];},
    (v) => {v.cohort.rollbackTo = [v.cohort.cohortId];},
    (v) => {v.cohort.upgradeFrom.push(v.cohort.upgradeFrom[0]);},
    (v) => {v.governedDocsRoots = ["../outside"];},
    (v) => {v.governedDocsRoots = []; v.governedDocsRoots.length = 1;},
    (v) => {v.cohort.upgradeFrom = []; v.cohort.upgradeFrom.length = 0xffffffff;},
    (v) => {v.extra = true;},
    (v) => {v.cycle = v;},
    (v) => {Object.setPrototypeOf(v.repository, { hidden: true });},
    (v) => {Object.defineProperty(v, "hidden", { value: true });},
    (v) => {v[Symbol("secret")] = true;}
  ]) {
    const input = desired();
    mutate(input);
    assert.throws(() => assertConsumerIntegrationDesiredStateV3(input), TypeError);
  }
  for (const input of [null, undefined, {}, [], "profile"]) {
    assert.throws(() => assertConsumerIntegrationDesiredStateV3(input), TypeError);
  }
  const accessor = desired();
  let reads = 0;
  Object.defineProperty(accessor.cohort, "channel", { enumerable: true, get() {reads++; return "rc";} });
  assert.throws(() => assertConsumerIntegrationDesiredStateV3(accessor), /accessors/u);
  assert.equal(reads, 0);
  assert.doesNotThrow(() => assertConsumerIntegrationDesiredStateV3(desired()));
});

test("optional portable projection leaves exact old managed state readable and stale plans refused", async () => {
  const { projectManagedPortableProfileV4 } = await import("../dist/index.js");
  const { readFile } = await import("node:fs/promises");
  const { compileKnownFileTransactionPlan } = await import("@agent-teams/repository-mutation");
  const { createConsumerIntegrationUseCases } = await import(
    "../dist/consumer-integration/application/use-cases/run-consumer-integration.js"
  );
  const target = desired();
  const current = applyFullAssetOperations(snapshot(), compileConsumerIntegration(
    { desired: target, snapshot: snapshot() }, ports([])
  ));
  const before = await readFile(new URL("./fixtures/managed-state-v2-original.json", import.meta.url));
  assert.equal(digest(before), "sha256:5759c488f584c6738e043f7dd643d0dd2c055aae4ad9d3301237b96918e8967a");
  assert.deepEqual(current.managedState.bytes, before, "current projection must reproduce original HEAD bytes");
  current.managedState = file(before);
  const historical = await readFile(new URL("./fixtures/managed-portable-profile-v3.yaml", import.meta.url));
  const postimage = await projectManagedPortableProfileV4(historical);
  const optionalPlan = compileKnownFileTransactionPlan({ operations: [{
    path: target.profilePath,
    precondition: { state: "known-file", acceptedPreimages: [{ bytes: historical, mode: 0o644 }] },
    postimage: { bytes: postimage, mode: 0o644 }
  }] });
  assert.equal(optionalPlan.operations.length, 1);
  assert.equal(optionalPlan.operations[0].path, target.profilePath);
  assert.deepEqual(Buffer.from(optionalPlan.operations[0].postimage.contentBase64, "base64"), postimage);
  assert.equal(compileConsumerIntegration({ desired: target, snapshot: current }, ports([])).plan.outcome, "current");
  assert.deepEqual(current.managedState.bytes, before);
  const pending = { ...current, skill: absent };
  const reviewed = compileConsumerIntegration({ desired: target, snapshot: pending }, ports([]));
  pending.integrationProfile = file("changed exact integration authority\n");
  let writes = 0;
  const useCases = createConsumerIntegrationUseCases({
    input: { async read() {return { root: "/disposable", desired: target, snapshot: pending };} },
    planning: ports([]), assets: { async read() {throw new Error("V1 catalog must not be read");} },
    transaction: {
      async inspect() {return { state: "idle" };},
      async apply() {writes++; throw new Error("must refuse before mutation");}
    }
  });
  const rejected = await useCases.apply({ consumerRoot: "/disposable", expect: reviewed.plan.planDigest });
  assert.equal(rejected.outcome, "blocked");
  assert.equal(rejected.issues[0].code, "DOCS_CONSUMER_STALE_PLAN");
  assert.equal(writes, 0);
  assert.deepEqual(current.managedState.bytes, before);
});
