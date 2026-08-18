import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  BOOTSTRAP_KNOWN_PRIOR_CALLER_WORKFLOWS,
  CANONICAL_DOCS_SKILL,
  canonicalCallerWorkflow,
  canonicalDocsScriptsDigest,
  canonicalManagedRoute,
  describeCanonicalConsumerAssets,
  planConsumerIntegration as publicPlanConsumerIntegration
} from "../dist/consumer-integration/index.js";
import { compileConsumerIntegration } from "../dist/consumer-integration/application/use-cases/plan-consumer-integration.js";
import { loadPackageConsumerAssetCatalog } from "../dist/consumer-integration/adapters/package-consumer-asset-catalog.js";
import {
  CANONICAL_ASSET_CATALOG,
  CANONICAL_CALLER_WORKFLOW_TEMPLATE,
  CANONICAL_TRANSITION_CATALOG,
  canonicalConsumerIntegrationJson
} from "../dist/consumer-integration/application/policies/consumer-integration-assets.js";

function planConsumerIntegration(input) {
  const compiled = compileConsumerIntegration(input);
  return { ...compiled.plan, mutationPlan: compiled.mutationPlan };
}

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const file = (value, mode = 0o644) => ({
  state: "file",
  bytes: Buffer.from(value, "utf8"),
  mode
});
const absent = { state: "absent" };
const INTEGRITY = `sha512-${"A".repeat(86)}==`;


function cohort() {
  const provisional = {
    schemaVersion: 1,
    cohortId: "docs-2026-08-16-rc1",
    channel: "rc",
    recordDigest: `sha256:${"1".repeat(64)}`,
    qualificationEventDigest: `sha256:${"2".repeat(64)}`,
    eligibleAfter: "2026-08-16T00:00:00Z",
    upgradeFrom: [],
    rollbackTo: [],
    packages: {
      docsProtocol: { version: "0.2.0-rc.0", integrity: INTEGRITY },
      engineeringFoundation: { version: "0.18.0-rc.0", integrity: INTEGRITY }
    },
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: "1".repeat(40),
      blobSha: "2".repeat(40)
    },
    assets: {
      skillDigest: `sha256:${"0".repeat(64)}`,
      callerWorkflowDigest: `sha256:${"0".repeat(64)}`
    },
    schemas: { consumerIntegration: 1, managedState: 1, docsProtocol: 1 },
    runtime: {
      node: ">=24.18.0 <25", pnpm: ">=11.17.0 <12",
      runtimeClosureDigest: "sha256:09e935888b0ea01aa7dbfdc6101685ae9402a26a4e34fa8e124b40780cf0788a"
    }
  };
  return { ...provisional, assets: describeCanonicalConsumerAssets(provisional) };
}

function desired() {
  return {
    schemaVersion: 1,
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
    cohort: cohort()
  };
}

function manifest(lineEnding = "\n") {
  return JSON.stringify({
    name: "consumer",
    private: true,
    scripts: Object.fromEntries(
      ["check", "doctor", "find", "info", "new", "recover"].map((command) => [
        `docs:${command}`,
        `agent-teams-docs ${command} --consumer . --profile architecture/foundation/docs-protocol.yaml`
      ])
    ),
    devDependencies: {
      "@agent-teams/docs-protocol": "0.2.0-rc.0",
      "@agent-teams/engineering-foundation": "0.18.0-rc.0",
      unrelated: "1.2.3"
    }
  }, null, 2).replaceAll("\n", lineEnding) + lineEnding;
}

function snapshot() {
  const target = cohort();
  return {
    integrationProfile: file("profile\n"),
    lockfile: file("lockfile\n"),
    packageManifest: file(manifest()),
    agents: file("# Agents\n\nUse [.agents/skills/docs-authoring/SKILL.md](.agents/skills/docs-authoring/SKILL.md) for documentation.\n"),
    skill: file(CANONICAL_DOCS_SKILL),
    callerWorkflow: file(canonicalCallerWorkflow(target)),
    managedState: absent
  };
}

test("plans only the legacy route migration and generated managed state", () => {
  const first = planConsumerIntegration({ desired: desired(), snapshot: snapshot() });
  const second = planConsumerIntegration({ desired: desired(), snapshot: snapshot() });
  assert.deepEqual(first, second);
  assert.equal(first.outcome, "change-required");
  assert.deepEqual(first.issues, []);
  assert.deepEqual(first.assets.filter(({ action }) => action !== "none").map(({ id, action }) => [id, action]), [
    ["agents-route", "replace"],
    ["managed-state", "create"]
  ]);
  assert.deepEqual(first.mutationPlan.operations.map(({ path }) => path), [
    "AGENTS.md",
    "architecture/foundation/docs-consumer-integration.json",
    "architecture/foundation/docs-protocol-managed-state.json",
    "pnpm-lock.yaml"
  ]);
  assert.match(first.planDigest, /^sha256:[0-9a-f]{64}$/u);
  const publicPlan = publicPlanConsumerIntegration({ desired: desired(), snapshot: snapshot() });
  const serialized = JSON.stringify(publicPlan);
  assert.equal(Object.hasOwn(publicPlan, "mutationPlan"), false);
  assert.doesNotMatch(serialized, /mutationPlan|acceptedPreimages|contentBase64/u);
  assert.ok(Buffer.byteLength(serialized) < 64 * 1024);
});

test("recognizes the qualified bootstrap caller without trusting arbitrary old bytes", () => {
  const current = snapshot();
  current.callerWorkflow = {
    state: "file",
    bytes: BOOTSTRAP_KNOWN_PRIOR_CALLER_WORKFLOWS[0],
    mode: 0o644
  };
  const plan = planConsumerIntegration({ desired: desired(), snapshot: current });
  assert.equal(
    plan.assets.find(({ id }) => id === "caller-workflow").action,
    "replace"
  );
  assert.equal(plan.outcome, "change-required");
});

test("recognizes the exact bootstrap caller on a renamed safe default branch", () => {
  const current = snapshot();
  current.callerWorkflow = file(Buffer.from(
    BOOTSTRAP_KNOWN_PRIOR_CALLER_WORKFLOWS[0]
  ).toString("utf8").replace("- main", "- trunk"));
  const plan = planConsumerIntegration({ desired: desired(), snapshot: current });
  assert.equal(plan.assets.find(({ id }) => id === "caller-workflow").action, "replace");
  assert.equal(plan.outcome, "change-required");
});

test("rejects executable path and workflow injection before rendering assets", () => {
  assert.throws(() => planConsumerIntegration({
    desired: { ...desired(), profilePath: "architecture/foundation/docs-protocol.yaml; touch pwned" },
    snapshot: snapshot()
  }), /invalid or unsupported/u);
  assert.throws(() => planConsumerIntegration({
    desired: {
      ...desired(),
      cohort: {
        ...desired().cohort,
        workflow: {
          ...desired().cohort.workflow,
          path: ".github/workflows/docs-protocol-check.yml\npermissions: write-all"
        }
      }
    },
    snapshot: snapshot()
  }), /invalid or unsupported/u);
});

test("rejects mutable lifecycle and canary fields in the committed binding", () => {
  const target = desired();
  target.cohort.lifecycleState = "RECOMMENDED";
  target.cohort.canaryRepositoryIds = [target.repository.id];
  assert.throws(
    () => planConsumerIntegration({ desired: target, snapshot: snapshot() }),
    /invalid or unsupported/u
  );
});

test("does not accept a transition claimed only by self-hashed managed state", () => {
  const initialDesired = desired();
  const initial = planConsumerIntegration({ desired: initialDesired, snapshot: snapshot() });
  const current = snapshot();
  for (const operation of initial.mutationPlan.operations) {
    const postimage = file(Buffer.from(operation.postimage.contentBase64, "base64").toString("utf8"));
    if (operation.path === "AGENTS.md") {current.agents = postimage;}
    if (operation.path.endsWith("managed-state.json")) {current.managedState = postimage;}
  }
  const target = desired();
  target.cohort = {
    ...target.cohort,
    cohortId: "docs-2026-08-18-rc3",
    qualificationEventDigest: `sha256:${"3".repeat(64)}`,
    upgradeFrom: []
  };
  const blocked = planConsumerIntegration({ desired: target, snapshot: current });
  assert.equal(blocked.outcome, "blocked");
  assert.ok(blocked.issues.some(({ code }) => code === "DOCS_CONSUMER_UNKNOWN_MANAGED_ASSET"));
});

test("creates an absent root AGENTS.md with only the canonical route", () => {
  const current = snapshot();
  current.agents = absent;
  const plan = planConsumerIntegration({ desired: desired(), snapshot: current });
  const asset = plan.assets.find(({ id }) => id === "agents-route");
  const operation = plan.mutationPlan.operations.find(({ path }) => path === "AGENTS.md");
  assert.equal(asset.action, "create");
  assert.deepEqual(operation.precondition, { state: "absent" });
  assert.equal(
    Buffer.from(operation.postimage.contentBase64, "base64").toString("utf8"),
    `${canonicalManagedRoute(desired().skillPath)}\n`
  );
});

test("canonical Skill contains executable identical preview and apply arguments", () => {
  assert.match(CANONICAL_DOCS_SKILL, /--title TITLE --owner OWNER --summary SUMMARY --dry-run/u);
  assert.match(CANONICAL_DOCS_SKILL, /--title TITLE --owner OWNER --summary SUMMARY --apply/u);
  assert.match(CANONICAL_DOCS_SKILL, /pnpm install --frozen-lockfile/u);
  assert.match(CANONICAL_DOCS_SKILL, /never use npx, dlx, or latest tags/u);
  assert.ok(CANONICAL_DOCS_SKILL.split("\n").length >= 20);
  assert.ok(CANONICAL_DOCS_SKILL.split("\n").length <= 30);
});

test("package-owned asset sources exactly match compiler constants and split catalog authority", async () => {
  const packageRoot = join(import.meta.dirname, "..");
  const [skill, workflow, catalogSource, transitionCatalogSource] = await Promise.all([
    readFile(join(packageRoot, "skills", "docs", "SKILL.md"), "utf8"),
    readFile(join(packageRoot, "assets", "docs-protocol.yml"), "utf8"),
    readFile(join(packageRoot, "assets", "catalog.json"), "utf8"),
    readFile(join(packageRoot, "assets", "transition-catalog.json"), "utf8")
  ]);
  assert.equal(skill, CANONICAL_DOCS_SKILL);
  assert.equal(workflow, CANONICAL_CALLER_WORKFLOW_TEMPLATE);
  assert.equal(catalogSource, CANONICAL_ASSET_CATALOG);
  assert.equal(transitionCatalogSource, CANONICAL_TRANSITION_CATALOG);
  const transitionCatalog = JSON.parse(transitionCatalogSource);
  assert.deepEqual(transitionCatalog.currentSourceExecutors, []);
  assert.deepEqual(
    transitionCatalog.directTargetBundles.map(({ cohort: { cohortId } }) => cohortId),
    ["docs-2026-08-17-rc1", "docs-2026-08-17-rc7", "docs-2026-08-17-rc9", "docs-2026-08-18-rc1"]
  );
  const loadedTransitions = await loadPackageConsumerAssetCatalog();
  assert.deepEqual(
    loadedTransitions.directTargetBundles.map(({ cohort: { cohortId } }) => cohortId),
    ["docs-2026-08-17-rc1", "docs-2026-08-17-rc7", "docs-2026-08-17-rc9", "docs-2026-08-18-rc1"]
  );
  const catalog = JSON.parse(catalogSource);
  assert.equal(catalog.skillDigest, digest(Buffer.from(skill)));
  assert.equal(catalog.callerWorkflowTemplateDigest, digest(Buffer.from(workflow)));
  assert.equal(catalog.routeTemplate, canonicalManagedRoute("{skillPath}"));
  assert.deepEqual(catalog.scriptsTemplate, Object.fromEntries(
    ["check", "doctor", "find", "info", "new", "recover"].map((command) => [
      `docs:${command}`,
      `agent-teams-docs ${command} --consumer . --profile {profilePath}`
    ])
  ));
  assert.equal(describeCanonicalConsumerAssets(cohort()).skillDigest, digest(Buffer.from(skill)));
  assert.equal(describeCanonicalConsumerAssets(cohort()).assetCatalogDigest, digest(Buffer.from(catalogSource)));
  assert.equal(
    describeCanonicalConsumerAssets(cohort()).transitionCatalogDigest,
    digest(Buffer.from(transitionCatalogSource))
  );
  assert.match(workflow, /^name: Documentation Protocol\n\non:\n  pull_request:\n  merge_group:\n  push:\n/u);
  assert.match(workflow, /\npermissions:\n  contents: read\n  id-token: write\n\njobs:\n/u);
  assert.equal(workflow.match(/^permissions:/gmu)?.length, 1);
  assert.doesNotMatch(workflow, /\bwith:/u);
});

test("becomes current after exact postimages and binds the changed observations", () => {
  const before = planConsumerIntegration({ desired: desired(), snapshot: snapshot() });
  const next = snapshot();
  for (const operation of before.mutationPlan.operations) {
    const postimage = file(Buffer.from(operation.postimage.contentBase64, "base64").toString("utf8"));
    if (operation.path === "AGENTS.md") {next.agents = postimage;}
    if (operation.path.endsWith("managed-state.json")) {next.managedState = postimage;}
  }
  const after = planConsumerIntegration({ desired: desired(), snapshot: next });
  assert.equal(after.outcome, "current");
  assert.equal(after.mutationPlan.operations.length, 0);
  assert.notEqual(after.planDigest, before.planDigest);
});

test("updates a repository rename by immutable ID but rejects an identity change", () => {
  const originalDesired = desired();
  const initial = planConsumerIntegration({ desired: originalDesired, snapshot: snapshot() });
  const current = snapshot();
  for (const operation of initial.mutationPlan.operations) {
    const postimage = file(Buffer.from(operation.postimage.contentBase64, "base64").toString("utf8"));
    if (operation.path === "AGENTS.md") {current.agents = postimage;}
    if (operation.path.endsWith("managed-state.json")) {current.managedState = postimage;}
  }
  const renamedDesired = {
    ...originalDesired,
    repository: { ...originalDesired.repository, nameWithOwner: "agent-teams-ai/runtime-renamed" }
  };
  const renamed = planConsumerIntegration({ desired: renamedDesired, snapshot: current });
  assert.equal(renamed.outcome, "change-required");
  assert.deepEqual(
    renamed.assets.filter(({ action }) => action !== "none").map(({ id }) => id),
    ["managed-state"]
  );

  const replacedIdentity = {
    ...renamedDesired,
    repository: { ...renamedDesired.repository, id: "1314129621" }
  };
  const rejected = planConsumerIntegration({ desired: replacedIdentity, snapshot: current });
  assert.equal(rejected.outcome, "blocked");
  assert.ok(rejected.issues.some(({ code, subject }) =>
    code === "DOCS_CONSUMER_UNKNOWN_MANAGED_ASSET" && subject.endsWith("managed-state.json")
  ));
});

test("refuses an unknown edit inside the reserved AGENTS route block", () => {
  const before = planConsumerIntegration({ desired: desired(), snapshot: snapshot() });
  const next = snapshot();
  for (const operation of before.mutationPlan.operations) {
    const postimage = file(Buffer.from(operation.postimage.contentBase64, "base64").toString("utf8"));
    if (operation.path === "AGENTS.md") {next.agents = postimage;}
    if (operation.path.endsWith("managed-state.json")) {next.managedState = postimage;}
  }
  next.agents = file(Buffer.from(next.agents.bytes).toString("utf8").replace(
    "Use [.agents/skills/docs-authoring/SKILL.md]",
    "Do something local, then use [.agents/skills/docs-authoring/SKILL.md]"
  ));
  const plan = planConsumerIntegration({ desired: desired(), snapshot: next });
  assert.equal(plan.outcome, "blocked");
  assert.ok(plan.issues.some(({ code }) => code === "DOCS_CONSUMER_AGENTS_ROUTE_CONFLICT"));
});

test("does not let self-hashed managed state authorize an asset upgrade or migration edge", () => {
  const initialDesired = desired();
  const initial = planConsumerIntegration({ desired: initialDesired, snapshot: snapshot() });
  const current = snapshot();
  for (const operation of initial.mutationPlan.operations) {
    const postimage = file(Buffer.from(operation.postimage.contentBase64, "base64").toString("utf8"));
    if (operation.path === "AGENTS.md") {current.agents = postimage;}
    if (operation.path.endsWith("managed-state.json")) {current.managedState = postimage;}
  }
  const provisional = {
    ...initialDesired.cohort,
    cohortId: "docs-2026-08-17-rc2",
    upgradeFrom: [initialDesired.cohort.cohortId],
    workflow: {
      ...initialDesired.cohort.workflow,
      revision: "3".repeat(40),
      blobSha: "4".repeat(40)
    },
    assets: {
      skillDigest: `sha256:${"0".repeat(64)}`,
      callerWorkflowDigest: `sha256:${"0".repeat(64)}`
    }
  };
  const upgradedDesired = {
    ...initialDesired,
    cohort: { ...provisional, assets: describeCanonicalConsumerAssets(provisional) }
  };
  const upgrade = planConsumerIntegration({ desired: upgradedDesired, snapshot: current });
  assert.equal(upgrade.outcome, "blocked");
  assert.ok(upgrade.issues.some(({ code, subject }) =>
    code === "DOCS_CONSUMER_UNKNOWN_MANAGED_ASSET" && subject.endsWith("managed-state.json")
  ));
});

test("permits only catalog-proven explicit rc-to-stable upgrade and rollback edges", () => {
  const sourceDesired = desired();
  sourceDesired.cohort = {
    ...sourceDesired.cohort,
    cohortId: "docs-b-rc",
    rollbackTo: ["docs-a-rc"]
  };
  sourceDesired.cohort = {
    ...sourceDesired.cohort,
    assets: describeCanonicalConsumerAssets(sourceDesired.cohort)
  };
  const rollbackDesired = desired();
  rollbackDesired.cohort = {
    ...rollbackDesired.cohort,
    cohortId: "docs-a-rc",
    workflow: { ...rollbackDesired.cohort.workflow, revision: "6".repeat(40) }
  };
  rollbackDesired.cohort = {
    ...rollbackDesired.cohort,
    assets: describeCanonicalConsumerAssets(rollbackDesired.cohort)
  };
  const rollbackEntry = Object.freeze({
    cohort: rollbackDesired.cohort,
    skill: Buffer.from(CANONICAL_DOCS_SKILL, "utf8"),
    callerWorkflow: Buffer.from(canonicalCallerWorkflow(rollbackDesired.cohort), "utf8"),
    agentsRouteDigest: digest(Buffer.from(canonicalManagedRoute(sourceDesired.skillPath), "utf8")),
    docsScriptsDigest: canonicalDocsScriptsDigest(sourceDesired.profilePath)
  });
  const sourceCompiled = compileConsumerIntegration({
    desired: sourceDesired,
    snapshot: snapshot(),
    knownPriorCohorts: [rollbackEntry]
  });
  const observed = snapshot();
  for (const operation of sourceCompiled.mutationPlan.operations) {
    const postimage = file(Buffer.from(operation.postimage.contentBase64, "base64").toString("utf8"));
    if (operation.path === "AGENTS.md") {observed.agents = postimage;}
    if (operation.path.endsWith("managed-state.json")) {observed.managedState = postimage;}
  }
  const entry = Object.freeze({
    cohort: sourceDesired.cohort,
    skill: Buffer.from(CANONICAL_DOCS_SKILL, "utf8"),
    callerWorkflow: Buffer.from(canonicalCallerWorkflow(sourceDesired.cohort), "utf8"),
    agentsRouteDigest: digest(Buffer.from(canonicalManagedRoute(sourceDesired.skillPath), "utf8")),
    docsScriptsDigest: canonicalDocsScriptsDigest(sourceDesired.profilePath)
  });
  const stableDesired = desired();
  stableDesired.cohort = {
    ...stableDesired.cohort,
    cohortId: "docs-c-stable",
    channel: "stable",
    upgradeFrom: [sourceDesired.cohort.cohortId],
    workflow: { ...stableDesired.cohort.workflow, revision: "5".repeat(40) }
  };
  stableDesired.cohort = {
    ...stableDesired.cohort,
    assets: describeCanonicalConsumerAssets(stableDesired.cohort)
  };
  const upgraded = compileConsumerIntegration({
    desired: stableDesired,
    snapshot: observed,
    knownPriorCohorts: [entry]
  }).plan;
  assert.equal(upgraded.outcome, "change-required");
  assert.equal(upgraded.issues.length, 0);

  const rolledBack = compileConsumerIntegration({
    desired: rollbackDesired,
    snapshot: observed,
    knownPriorCohorts: [entry]
  }).plan;
  assert.equal(rolledBack.outcome, "change-required");
  assert.equal(rolledBack.issues.length, 0);

  const forbiddenDesired = {
    ...stableDesired,
    cohort: { ...stableDesired.cohort, upgradeFrom: [] }
  };
  const forbidden = compileConsumerIntegration({
    desired: forbiddenDesired,
    snapshot: observed,
    knownPriorCohorts: [entry]
  }).plan;
  assert.equal(forbidden.outcome, "blocked");
  assert.ok(forbidden.issues.some(({ code }) => code === "DOCS_CONSUMER_COHORT_TRANSITION_FORBIDDEN"));

  const shadowCohort = {
    ...sourceDesired.cohort,
    cohortId: "docs-b-shadow",
    recordDigest: `sha256:${"7".repeat(64)}`
  };
  const shadowEntry = Object.freeze({ ...entry, cohort: shadowCohort });
  const forgedRecord = JSON.parse(Buffer.from(observed.managedState.bytes).toString("utf8"));
  forgedRecord.cohortId = shadowCohort.cohortId;
  delete forgedRecord.stateDigest;
  forgedRecord.stateDigest = digest(Buffer.from(canonicalConsumerIntegrationJson({
    domain: "agent-teams.docs-protocol.managed-state/v1",
    body: forgedRecord
  }), "utf8"));
  observed.managedState = file(`${canonicalConsumerIntegrationJson(forgedRecord)}\n`);
  const forgedTarget = {
    ...stableDesired,
    cohort: { ...stableDesired.cohort, upgradeFrom: [shadowCohort.cohortId] }
  };
  const forged = compileConsumerIntegration({
    desired: forgedTarget,
    snapshot: observed,
    knownPriorCohorts: [entry, shadowEntry]
  }).plan;
  assert.equal(forged.outcome, "blocked");
  assert.ok(forged.issues.some(({ code }) => code === "DOCS_CONSUMER_UNKNOWN_MANAGED_ASSET"));
});

test("blocks unknown managed bytes and package-manager-owned cohort pin drift", () => {
  const unknown = snapshot();
  unknown.skill = file("locally changed skill\n");
  const skillConflict = planConsumerIntegration({ desired: desired(), snapshot: unknown });
  assert.equal(skillConflict.outcome, "blocked");
  assert.equal(skillConflict.mutationPlan, undefined);
  assert.ok(skillConflict.issues.some(({ code }) => code === "DOCS_CONSUMER_UNKNOWN_MANAGED_ASSET"));

  const stale = snapshot();
  stale.packageManifest = file(manifest().replace("0.2.0-rc.0", "0.1.0-rc.1"));
  const pinConflict = planConsumerIntegration({ desired: desired(), snapshot: stale });
  assert.equal(pinConflict.outcome, "blocked");
  assert.ok(pinConflict.issues.some(({ code }) => code === "DOCS_CONSUMER_COHORT_PIN_REQUIRED"));
});

test("preserves CRLF and unrelated manifest fields when adding a missing reserved script", () => {
  const current = snapshot();
  current.packageManifest = file(manifest("\r\n").replace(
    /,\r\n    "docs:recover": .*\r\n/u,
    "\r\n"
  ));
  const plan = planConsumerIntegration({ desired: desired(), snapshot: current });
  const operation = plan.mutationPlan.operations.find(({ path }) => path === "package.json");
  assert.ok(operation);
  const postimage = Buffer.from(operation.postimage.contentBase64, "base64").toString("utf8");
  assert.ok(postimage.includes("\r\n"));
  assert.equal(postimage.replaceAll("\r\n", "").includes("\n"), false);
  assert.match(postimage, /"unrelated": "1\.2\.3"/u);
});
