import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOTSTRAP_KNOWN_PRIOR_CALLER_WORKFLOWS,
  CANONICAL_DOCS_SKILL,
  canonicalCallerWorkflow,
  describeCanonicalConsumerAssets,
  planConsumerIntegration
} from "../dist/consumer-integration/index.js";

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
    lifecycleState: "RECOMMENDED",
    eligibleAfter: "2026-08-16T00:00:00Z",
    upgradeFrom: [],
    rollbackTo: [],
    canaryRepositoryIds: ["1314129620"],
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
    runtime: { node: ">=24.18.0 <25", pnpm: ">=11.17.0 <12" }
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

test("blocks invented cohort transitions and permits only declared edges", () => {
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
  assert.ok(blocked.issues.some(({ code }) => code === "DOCS_CONSUMER_COHORT_TRANSITION_FORBIDDEN"));
});

test("canonical Skill contains executable identical preview and apply arguments", () => {
  assert.match(CANONICAL_DOCS_SKILL, /--title TITLE --owner OWNER --summary SUMMARY --dry-run/u);
  assert.match(CANONICAL_DOCS_SKILL, /--title TITLE --owner OWNER --summary SUMMARY --apply/u);
  assert.match(CANONICAL_DOCS_SKILL, /pnpm install --frozen-lockfile/u);
  assert.match(CANONICAL_DOCS_SKILL, /never use npx, dlx, or latest tags/u);
  assert.ok(CANONICAL_DOCS_SKILL.split("\n").length >= 20);
  assert.ok(CANONICAL_DOCS_SKILL.split("\n").length <= 30);
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

test("uses a self-authenticating managed state to authorize a cohort asset upgrade", () => {
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
  assert.equal(upgrade.outcome, "change-required");
  assert.deepEqual(upgrade.issues, []);
  assert.deepEqual(
    upgrade.assets.filter(({ action }) => action !== "none").map(({ id }) => id),
    ["caller-workflow", "managed-state"]
  );
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
