import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { docsCheckV2, docsContextV1 } from "@agent-teams/docs-protocol";

import {
  BOOTSTRAP_KNOWN_PRIOR_DOCS_SKILLS,
  CANONICAL_DOCS_SKILL_V2,
  canonicalCallerWorkflow,
  canonicalDocsScripts,
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

test("managed canonical Skill supports portable adoption and bounded context with a custom profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-portable-adoption-"));
  const profilePath = "config/custom-docs.yaml";
  try {
    await cp(new URL("../../docs-protocol/tests/fixtures/portable-qualification/", import.meta.url), root, { recursive: true });
    await mkdir(join(root, "config"));
    await rename(join(root, "docs.config.yaml"), join(root, profilePath));
    await writeFile(join(root, ".agents/skills/docs-authoring/SKILL.md"), CANONICAL_DOCS_SKILL_V2);
    const scripts = canonicalDocsScripts(profilePath);
    assert.equal(scripts["docs:context"], undefined, "context must not expand historical managed script ownership");
    assert.equal(scripts["docs:info"], `agent-teams-docs info --consumer . --profile ${profilePath}`);
    const check = await docsCheckV2({ consumerRoot: root, profilePath });
    assert.equal(check.envelope.outcome, "success", JSON.stringify(check.envelope.diagnostics));
    const context = await docsContextV1({ consumerRoot: root, profilePath, query: {},
      limits: { maxDocuments: 1, maxBytes: 4096 } });
    assert.equal(context.envelope.outcome, "success", JSON.stringify(context.envelope.diagnostics));
    assert.deepEqual(context.envelope.result.limits, { maxDocuments: 1, maxBytes: 4096 });
    assert.ok(context.envelope.result.includedDocuments > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
