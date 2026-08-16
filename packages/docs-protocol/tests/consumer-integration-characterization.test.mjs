import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  describeCanonicalConsumerAssets,
  planConsumerIntegration
} from "../dist/consumer-integration/index.js";

const shapes = JSON.parse(await readFile(
  join(import.meta.dirname, "fixtures", "current-consumer-shapes.v1.json"),
  "utf8"
));

const absent = { state: "absent" };
const file = (bytes) => ({ state: "file", bytes, mode: 0o644 });
const decode = (value) => Buffer.from(value, "base64");

function cohort() {
  const provisional = {
    schemaVersion: 1,
    cohortId: "docs-2026-08-16-rc1",
    channel: "rc",
    packages: {
      docsProtocol: { version: "0.2.0-rc.0", integrity: "sha512-ZG9jcw==" },
      engineeringFoundation: { version: "0.18.0-rc.0", integrity: "sha512-Zm91bmRhdGlvbg==" }
    },
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: "1".repeat(40),
      blobSha: "2".repeat(40)
    },
    assets: {
      skillDigest: `sha256:${"0".repeat(64)}`,
      callerWorkflowDigest: `sha256:${"0".repeat(64)}`,
      assetCatalogDigest: `sha256:${"0".repeat(64)}`
    },
    schemas: { consumerIntegration: 1, managedState: 1, docsProtocol: 1 },
    runtime: { node: ">=24.18.0 <25", pnpm: ">=11.17.0 <12" }
  };
  return { ...provisional, assets: describeCanonicalConsumerAssets(provisional) };
}

function upgradedManifest(base64) {
  let source = decode(base64).toString("utf8");
  for (const [name, previous, next] of [
    ["@agent-teams/docs-protocol", "0.1.0-rc.1", "0.2.0-rc.0"],
    ["@agent-teams/engineering-foundation", "0.17.0-rc.0", "0.18.0-rc.0"]
  ]) {
    const before = `"${name}": "${previous}"`;
    assert.equal(source.split(before).length - 1, 1, `${name} fixture pin`);
    source = source.replace(before, `"${name}": "${next}"`);
  }
  return Buffer.from(source, "utf8");
}

for (const shape of shapes.fixtures) {
  test(`characterizes ${shape.repository.nameWithOwner} without repo-specific compiler code`, () => {
    const desired = {
      schemaVersion: 1,
      repository: shape.repository,
      integrationRoot: ".",
      packageManager: "pnpm",
      profilePath: "architecture/foundation/docs-protocol.yaml",
      skillPath: ".agents/skills/docs-authoring/SKILL.md",
      callerWorkflowPath: ".github/workflows/docs-protocol.yml",
      managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
      cohort: cohort()
    };
    const snapshot = {
      packageManifest: file(upgradedManifest(shape.files.packageJsonBase64)),
      agents: file(decode(shape.files.agentsBase64)),
      skill: file(decode(shape.files.skillBase64)),
      callerWorkflow: shape.callerKind === "standalone"
        ? file(decode(shape.files.callerWorkflowBase64))
        : absent,
      managedState: absent
    };
    const first = planConsumerIntegration({ desired, snapshot });
    const replay = planConsumerIntegration({ desired, snapshot });
    assert.deepEqual(replay, first);
    assert.equal(first.outcome, "change-required");
    assert.deepEqual(first.issues, []);
    assert.deepEqual(
      first.assets.filter(({ action }) => action !== "none").map(({ id, action }) => [id, action]),
      shape.callerKind === "standalone"
        ? [["caller-workflow", "replace"], ["agents-route", "replace"], ["managed-state", "create"]]
        : [["caller-workflow", "create"], ["agents-route", "replace"], ["managed-state", "create"]]
    );
    assert.equal(first.assets.find(({ id }) => id === "package-manifest").action, "none");
    assert.equal(first.assets.find(({ id }) => id === "skill").action, "none");
  });
}
