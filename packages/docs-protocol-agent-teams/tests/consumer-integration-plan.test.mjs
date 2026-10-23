import { assertCanonicalPackageAssets } from "./consumer-package-asset-assertions.ts";
import { file, absent, cohort, desired, manifest, snapshot } from "./consumer-plan-fixture.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import test from "node:test";

import {
  BOOTSTRAP_KNOWN_PRIOR_CALLER_WORKFLOWS,
  CANONICAL_DOCS_SKILL,
  canonicalCallerWorkflow,
  canonicalDocsScriptsDigest,
  canonicalManagedRoute,
  describeCanonicalConsumerAssets,
  planConsumerIntegration as publicPlanConsumerIntegration,
} from "../dist/consumer-integration/index.js";
import { compileConsumerIntegration } from "../dist/consumer-integration/composition/consumer-integration-planner.js";

import {
  CANONICAL_DOCS_SKILL_V2,
  canonicalConsumerIntegrationJson,
} from "../dist/consumer-integration/application/policies/consumer-integration-assets.js";

function planConsumerIntegration(input) {
  const compiled = compileConsumerIntegration(input);
  return { ...compiled.plan, mutationPlan: compiled.mutationPlan };
}

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("plans only the legacy route migration and generated managed state", () => {
  const first = planConsumerIntegration({ desired: desired(), snapshot: snapshot() });
  const second = planConsumerIntegration({ desired: desired(), snapshot: snapshot() });
  assert.deepEqual(first, second);
  assert.equal(first.outcome, "change-required");
  assert.deepEqual(first.issues, []);
  assert.deepEqual(
    first.assets.filter(({ action }) => action !== "none").map(({ id, action }) => [id, action]),
    [
      ["agents-route", "replace"],
      ["managed-state", "create"],
    ],
  );
  assert.deepEqual(
    first.mutationPlan.operations.map(({ path }) => path),
    [
      "AGENTS.md",
      "architecture/foundation/docs-consumer-integration.json",
      "architecture/foundation/docs-protocol-managed-state.json",
      "pnpm-lock.yaml",
    ],
  );
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
    mode: 0o644,
  };
  const plan = planConsumerIntegration({ desired: desired(), snapshot: current });
  assert.equal(plan.assets.find(({ id }) => id === "caller-workflow").action, "replace");
  assert.equal(plan.outcome, "change-required");
});

test("upgrades the exact published v1 Skill without managed-state authority", () => {
  const current = snapshot();
  current.skill = file(CANONICAL_DOCS_SKILL);
  const plan = planConsumerIntegration({ desired: desired(), snapshot: current });
  assert.deepEqual(
    [
      current.managedState.state,
      plan.outcome,
      plan.issues,
      plan.assets.find(({ id }) => id === "skill").action,
      plan.assets.find(({ id }) => id === "managed-state").action,
    ],
    ["absent", "change-required", [], "replace", "create"],
  );
});

test("recognizes the exact bootstrap caller on a renamed safe default branch", () => {
  const current = snapshot();
  current.callerWorkflow = file(
    Buffer.from(BOOTSTRAP_KNOWN_PRIOR_CALLER_WORKFLOWS[0])
      .toString("utf8")
      .replace("- main", "- trunk"),
  );
  const plan = planConsumerIntegration({ desired: desired(), snapshot: current });
  assert.equal(plan.assets.find(({ id }) => id === "caller-workflow").action, "replace");
  assert.equal(plan.outcome, "change-required");
});

test("rejects executable path and workflow injection before rendering assets", () => {
  assert.throws(
    () =>
      planConsumerIntegration({
        desired: {
          ...desired(),
          profilePath: "architecture/foundation/docs-protocol.yaml; touch pwned",
        },
        snapshot: snapshot(),
      }),
    /invalid or unsupported/u,
  );
  assert.throws(
    () =>
      planConsumerIntegration({
        desired: {
          ...desired(),
          cohort: {
            ...desired().cohort,
            workflow: {
              ...desired().cohort.workflow,
              path: ".github/workflows/docs-protocol-check.yml\npermissions: write-all",
            },
          },
        },
        snapshot: snapshot(),
      }),
    /invalid or unsupported/u,
  );
});

test("rejects mutable lifecycle and canary fields in the committed binding", () => {
  const target = desired();
  target.cohort.lifecycleState = "RECOMMENDED";
  target.cohort.canaryRepositoryIds = [target.repository.id];
  assert.throws(
    () => planConsumerIntegration({ desired: target, snapshot: snapshot() }),
    /invalid or unsupported/u,
  );
});

test("does not accept a transition claimed only by self-hashed managed state", () => {
  const initialDesired = desired();
  const initial = planConsumerIntegration({ desired: initialDesired, snapshot: snapshot() });
  const current = snapshot();
  for (const operation of initial.mutationPlan.operations) {
    const postimage = file(
      Buffer.from(operation.postimage.contentBase64, "base64").toString("utf8"),
    );
    if (operation.path === "AGENTS.md") {
      current.agents = postimage;
    }
    if (operation.path.endsWith("managed-state.json")) {
      current.managedState = postimage;
    }
  }
  const target = desired();
  target.cohort = {
    ...target.cohort,
    cohortId: "docs-2026-08-18-rc3",
    qualificationEventDigest: `sha256:${"3".repeat(64)}`,
    upgradeFrom: [],
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
    `${canonicalManagedRoute(desired().skillPath)}\n`,
  );
});

test("canonical Skill contains executable identical preview and apply arguments", () => {
  assert.match(CANONICAL_DOCS_SKILL_V2, /--title TITLE --owner OWNER --summary SUMMARY --dry-run/u);
  assert.match(CANONICAL_DOCS_SKILL_V2, /--title TITLE --owner OWNER --summary SUMMARY --apply/u);
  assert.match(CANONICAL_DOCS_SKILL_V2, /pnpm install --frozen-lockfile/u);
  assert.match(CANONICAL_DOCS_SKILL_V2, /never use npx, dlx, or latest tags/u);
  assert.ok(CANONICAL_DOCS_SKILL_V2.split("\n").length >= 20);
  assert.ok(CANONICAL_DOCS_SKILL_V2.trimEnd().split("\n").length <= 80);
});

test("package-owned asset sources exactly match compiler constants and split catalog authority", async () => {
  await assertCanonicalPackageAssets(cohort());
});

test("becomes current after exact postimages and binds the changed observations", () => {
  const before = planConsumerIntegration({ desired: desired(), snapshot: snapshot() });
  const next = snapshot();
  for (const operation of before.mutationPlan.operations) {
    const postimage = file(
      Buffer.from(operation.postimage.contentBase64, "base64").toString("utf8"),
    );
    if (operation.path === "AGENTS.md") {
      next.agents = postimage;
    }
    if (operation.path.endsWith("managed-state.json")) {
      next.managedState = postimage;
    }
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
    const postimage = file(
      Buffer.from(operation.postimage.contentBase64, "base64").toString("utf8"),
    );
    if (operation.path === "AGENTS.md") {
      current.agents = postimage;
    }
    if (operation.path.endsWith("managed-state.json")) {
      current.managedState = postimage;
    }
  }
  const renamedDesired = {
    ...originalDesired,
    repository: { ...originalDesired.repository, nameWithOwner: "agent-teams-ai/runtime-renamed" },
  };
  const renamed = planConsumerIntegration({ desired: renamedDesired, snapshot: current });
  assert.equal(renamed.outcome, "change-required");
  assert.deepEqual(
    renamed.assets.filter(({ action }) => action !== "none").map(({ id }) => id),
    ["managed-state"],
  );

  const replacedIdentity = {
    ...renamedDesired,
    repository: { ...renamedDesired.repository, id: "1314129621" },
  };
  const rejected = planConsumerIntegration({ desired: replacedIdentity, snapshot: current });
  assert.equal(rejected.outcome, "blocked");
  assert.ok(
    rejected.issues.some(
      ({ code, subject }) =>
        code === "DOCS_CONSUMER_UNKNOWN_MANAGED_ASSET" && subject.endsWith("managed-state.json"),
    ),
  );
});

test("refuses an unknown edit inside the reserved AGENTS route block", () => {
  const before = planConsumerIntegration({ desired: desired(), snapshot: snapshot() });
  const next = snapshot();
  for (const operation of before.mutationPlan.operations) {
    const postimage = file(
      Buffer.from(operation.postimage.contentBase64, "base64").toString("utf8"),
    );
    if (operation.path === "AGENTS.md") {
      next.agents = postimage;
    }
    if (operation.path.endsWith("managed-state.json")) {
      next.managedState = postimage;
    }
  }
  next.agents = file(
    Buffer.from(next.agents.bytes)
      .toString("utf8")
      .replace(
        "Use [.agents/skills/docs-authoring/SKILL.md]",
        "Do something local, then use [.agents/skills/docs-authoring/SKILL.md]",
      ),
  );
  const plan = planConsumerIntegration({ desired: desired(), snapshot: next });
  assert.equal(plan.outcome, "blocked");
  assert.ok(plan.issues.some(({ code }) => code === "DOCS_CONSUMER_AGENTS_ROUTE_CONFLICT"));
});

test("does not let self-hashed managed state authorize an asset upgrade or migration edge", () => {
  const initialDesired = desired();
  const initial = planConsumerIntegration({ desired: initialDesired, snapshot: snapshot() });
  const current = snapshot();
  for (const operation of initial.mutationPlan.operations) {
    const postimage = file(
      Buffer.from(operation.postimage.contentBase64, "base64").toString("utf8"),
    );
    if (operation.path === "AGENTS.md") {
      current.agents = postimage;
    }
    if (operation.path.endsWith("managed-state.json")) {
      current.managedState = postimage;
    }
  }
  const provisional = {
    ...initialDesired.cohort,
    cohortId: "docs-2026-08-17-rc2",
    upgradeFrom: [initialDesired.cohort.cohortId],
    workflow: {
      ...initialDesired.cohort.workflow,
      revision: "3".repeat(40),
      blobSha: "4".repeat(40),
    },
    assets: {
      skillDigest: `sha256:${"0".repeat(64)}`,
      callerWorkflowDigest: `sha256:${"0".repeat(64)}`,
    },
  };
  const upgradedDesired = {
    ...initialDesired,
    cohort: { ...provisional, assets: describeCanonicalConsumerAssets(provisional) },
  };
  const upgrade = planConsumerIntegration({ desired: upgradedDesired, snapshot: current });
  assert.equal(upgrade.outcome, "blocked");
  assert.ok(
    upgrade.issues.some(
      ({ code, subject }) =>
        code === "DOCS_CONSUMER_UNKNOWN_MANAGED_ASSET" && subject.endsWith("managed-state.json"),
    ),
  );
});

test("permits only catalog-proven explicit rc-to-stable upgrade and rollback edges", () => {
  const sourceDesired = desired();
  sourceDesired.cohort = {
    ...sourceDesired.cohort,
    cohortId: "docs-b-rc",
    rollbackTo: ["docs-a-rc"],
  };
  sourceDesired.cohort = {
    ...sourceDesired.cohort,
    assets: describeCanonicalConsumerAssets(sourceDesired.cohort),
  };
  const rollbackDesired = desired();
  rollbackDesired.cohort = {
    ...rollbackDesired.cohort,
    cohortId: "docs-a-rc",
    workflow: { ...rollbackDesired.cohort.workflow, revision: "6".repeat(40) },
  };
  rollbackDesired.cohort = {
    ...rollbackDesired.cohort,
    assets: describeCanonicalConsumerAssets(rollbackDesired.cohort),
  };
  const rollbackEntry = Object.freeze({
    cohort: rollbackDesired.cohort,
    skill: Buffer.from(CANONICAL_DOCS_SKILL_V2, "utf8"),
    callerWorkflow: Buffer.from(canonicalCallerWorkflow(rollbackDesired.cohort), "utf8"),
    agentsRouteDigest: digest(Buffer.from(canonicalManagedRoute(sourceDesired.skillPath), "utf8")),
    docsScriptsDigest: canonicalDocsScriptsDigest(sourceDesired.profilePath),
  });
  const sourceCompiled = compileConsumerIntegration({
    desired: sourceDesired,
    snapshot: snapshot(),
    knownPriorCohorts: [rollbackEntry],
  });
  const observed = snapshot();
  for (const operation of sourceCompiled.mutationPlan.operations) {
    const postimage = file(
      Buffer.from(operation.postimage.contentBase64, "base64").toString("utf8"),
    );
    if (operation.path === "AGENTS.md") {
      observed.agents = postimage;
    }
    if (operation.path.endsWith("managed-state.json")) {
      observed.managedState = postimage;
    }
  }
  const entry = Object.freeze({
    cohort: sourceDesired.cohort,
    skill: Buffer.from(CANONICAL_DOCS_SKILL_V2, "utf8"),
    callerWorkflow: Buffer.from(canonicalCallerWorkflow(sourceDesired.cohort), "utf8"),
    agentsRouteDigest: digest(Buffer.from(canonicalManagedRoute(sourceDesired.skillPath), "utf8")),
    docsScriptsDigest: canonicalDocsScriptsDigest(sourceDesired.profilePath),
  });
  const stableDesired = desired();
  stableDesired.cohort = {
    ...stableDesired.cohort,
    cohortId: "docs-c-stable",
    channel: "stable",
    upgradeFrom: [sourceDesired.cohort.cohortId],
    workflow: { ...stableDesired.cohort.workflow, revision: "5".repeat(40) },
  };
  stableDesired.cohort = {
    ...stableDesired.cohort,
    assets: describeCanonicalConsumerAssets(stableDesired.cohort),
  };
  const upgraded = compileConsumerIntegration({
    desired: stableDesired,
    snapshot: observed,
    knownPriorCohorts: [entry],
  }).plan;
  assert.equal(upgraded.outcome, "change-required");
  assert.equal(upgraded.issues.length, 0);

  const rolledBack = compileConsumerIntegration({
    desired: rollbackDesired,
    snapshot: observed,
    knownPriorCohorts: [entry],
  }).plan;
  assert.equal(rolledBack.outcome, "change-required");
  assert.equal(rolledBack.issues.length, 0);

  const forbiddenDesired = {
    ...stableDesired,
    cohort: { ...stableDesired.cohort, upgradeFrom: [] },
  };
  const forbidden = compileConsumerIntegration({
    desired: forbiddenDesired,
    snapshot: observed,
    knownPriorCohorts: [entry],
  }).plan;
  assert.equal(forbidden.outcome, "blocked");
  assert.ok(
    forbidden.issues.some(({ code }) => code === "DOCS_CONSUMER_COHORT_TRANSITION_FORBIDDEN"),
  );

  const shadowCohort = {
    ...sourceDesired.cohort,
    cohortId: "docs-b-shadow",
    recordDigest: `sha256:${"7".repeat(64)}`,
  };
  const shadowEntry = Object.freeze({ ...entry, cohort: shadowCohort });
  const forgedRecord = JSON.parse(Buffer.from(observed.managedState.bytes).toString("utf8"));
  forgedRecord.cohortId = shadowCohort.cohortId;
  delete forgedRecord.stateDigest;
  forgedRecord.stateDigest = digest(
    Buffer.from(
      canonicalConsumerIntegrationJson({
        domain: "agent-teams.docs-protocol.managed-state/v1",
        body: forgedRecord,
      }),
      "utf8",
    ),
  );
  observed.managedState = file(`${canonicalConsumerIntegrationJson(forgedRecord)}\n`);
  const forgedTarget = {
    ...stableDesired,
    cohort: { ...stableDesired.cohort, upgradeFrom: [shadowCohort.cohortId] },
  };
  const forged = compileConsumerIntegration({
    desired: forgedTarget,
    snapshot: observed,
    knownPriorCohorts: [entry, shadowEntry],
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
  assert.ok(
    skillConflict.issues.some(({ code }) => code === "DOCS_CONSUMER_UNKNOWN_MANAGED_ASSET"),
  );

  const stale = snapshot();
  stale.packageManifest = file(manifest().replace("0.2.0-rc.0", "0.1.0-rc.1"));
  const pinConflict = planConsumerIntegration({ desired: desired(), snapshot: stale });
  assert.equal(pinConflict.outcome, "blocked");
  assert.ok(pinConflict.issues.some(({ code }) => code === "DOCS_CONSUMER_COHORT_PIN_REQUIRED"));
});

test("preserves CRLF and unrelated manifest fields when adding a missing reserved script", () => {
  const current = snapshot();
  current.packageManifest = file(
    manifest("\r\n").replace(/,\r\n    "docs:recover": .*\r\n/u, "\r\n"),
  );
  const plan = planConsumerIntegration({ desired: desired(), snapshot: current });
  const operation = plan.mutationPlan.operations.find(({ path }) => path === "package.json");
  assert.ok(operation);
  const postimage = Buffer.from(operation.postimage.contentBase64, "base64").toString("utf8");
  assert.ok(postimage.includes("\r\n"));
  assert.equal(postimage.replaceAll("\r\n", "").includes("\n"), false);
  assert.match(postimage, /"unrelated": "1\.2\.3"/u);
});
