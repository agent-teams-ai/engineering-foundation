import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import * as projectors from "../dist/consumer-integration/adapters/consumer-upgrade-file-projectors.js";

const historical = {
  schemaVersion: 3,
  protocol: { id: "agent-teams.docs-protocol", version: 1 },
  foundationProfile: {
    path: "architecture/foundation/document-authoring.yaml", schemaVersion: 3,
    metadataSidecarPolicy: "foundation-profile-v3-strict-merge"
  },
  agentWorkflow: { adoption: "portable-v1", skillPath: ".agents/skills/docs-authoring/SKILL.md" },
  semanticValidatorIds: ["docs/decisions", "architecture/links"]
};
const vocabulary = {
  types: ["open-decision"], statuses: ["deferred", "open"],
  subjectIncompatibleStatuses: ["accepted", "active"]
};

test("managed portable v4 projection explicitly preserves managed paths and validator IDs", async () => {
  assert.equal(typeof projectors.projectManagedPortableProfileV4, "function");
  const bytes = Buffer.from(stringify(historical));
  const before = Buffer.from(bytes);
  const projected = parse(Buffer.from(await projectors.projectManagedPortableProfileV4(bytes)).toString("utf8"));
  assert.deepEqual(projected, { ...historical, schemaVersion: 4, relations: { blockers: vocabulary },
    semanticValidatorIds: ["architecture/links", "docs/decisions"] });
  assert.deepEqual(bytes, before);
});

test("managed qualification fixture selects explicit portable v4", async () => {
  const fixture = parse(await readFile(new URL("./fixtures/qualification/architecture/foundation/docs-protocol.yaml", import.meta.url), "utf8"));
  assert.equal(fixture.schemaVersion, 4);
  assert.deepEqual(fixture.relations, { blockers: vocabulary });
});

test("portable migration rejects unknown, executable, mixed and nonportable input without effects", async () => {
  for (const value of [
    { ...historical, schemaVersion: 4 },
    { ...historical, relations: { blockers: vocabulary } },
    { ...historical, hook: "run-tool" },
    { ...historical, semanticValidatorIds: ["duplicate", "duplicate"] },
    { ...historical, agentWorkflow: { ...historical.agentWorkflow, adoption: "managed-v2" } },
    { ...historical, foundationProfile: { ...historical.foundationProfile, schemaVersion: 2 } },
    { ...historical, foundationProfile: { ...historical.foundationProfile, path: "docs/CON.yaml" } },
    { ...historical, agentWorkflow: { ...historical.agentWorkflow, skillPath: "docs./SKILL.md" } }
  ]) {
    const bytes = Buffer.from(stringify(value));
    const before = Buffer.from(bytes);
    await assert.rejects(projectors.projectManagedPortableProfileV4(bytes), TypeError);
    assert.deepEqual(bytes, before);
  }
  for (const source of [
    `${stringify(historical)}schemaVersion: 3\n`,
    `${stringify(historical)}extra: &v [one]\ncopy: *v\n`,
    `${stringify(historical)}extra: !custom value\n`,
    "x".repeat(128 * 1024 + 1),
    Buffer.from([0xff])
  ]) {
    await assert.rejects(projectors.projectManagedPortableProfileV4(Buffer.from(source)));
  }
});

const blocker = (status, type = "open-decision") => `---\nid: OD-0001\ntype: ${type}\nstatus: ${status}\nowner: architecture/tooling\nsummary: Pending decision.\n---\n\n# Pending decision\n`;

test("portable v4 consumer enforces concrete managed vocabulary through preview, apply and corpus", {
  skip: process.platform === "win32" && "Known-file mutation is unsupported on Windows; projection parsing remains qualified separately."
}, async () => {
  const { cp, mkdtemp, realpath, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { docsNewV2, docsCheckV2, docsInfoV2 } = await import("@agent-teams/docs-protocol");
  const { bootstrapQualificationInstallation, snapshot } = await import("@agent-teams/docs-protocol/qualification");
  const { overlayLocalDevelopmentSkill } = await import("../dist/qualification/adapters/outbound/node-managed-qualification.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "managed-portable-v4-")));
  try {
    await cp(new URL("./fixtures/qualification/", import.meta.url), root, { recursive: true });
    await bootstrapQualificationInstallation(root, true);
    await overlayLocalDevelopmentSkill(root, historical.agentWorkflow.skillPath, true);
    const profilePath = "architecture/foundation/docs-protocol.yaml";
    const request = { consumerRoot: root, profilePath };
    // The reviewed producer prerequisite must actually read v4 before this test claims qualification.
    const info = await docsInfoV2(request);
    assert.equal(info.exitCode, 0, JSON.stringify(info));
    const metadataPath = join(root, "docs/metadata.schema.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.properties.type.enum.push("open-decision");
    metadata.properties.status.enum.push("accepted", "deferred", "open", "closed");
    await writeFile(metadataPath, JSON.stringify(metadata));
    const blockerPath = join(root, "docs/decisions/blocker.md");
    const base = { ...request, intent: { type: "adr", id: "ADR-0001", title: "Managed vocabulary", owner: "architecture/tooling", summary: "Qualifies explicit managed vocabulary." }, blockedBy: ["OD-0001"] };
    for (const status of ["deferred", "open"]) {
      await writeFile(blockerPath, blocker(status));
      const preview = await docsNewV2({ ...base, apply: false });
      assert.equal(preview.exitCode, 0, JSON.stringify(preview));
    }
    for (const [status, type] of [["closed", "open-decision"], ["open", "adr"]]) {
      await writeFile(blockerPath, blocker(status, type));
      await assert.rejects(docsNewV2({ ...base, apply: false }), /configured blocker/u);
    }
    await writeFile(blockerPath, blocker("open"));
    const authoringPath = join(root, historical.foundationProfile.path);
    const authoring = await readFile(authoringPath, "utf8");
    for (const status of ["accepted", "active"]) {
      await writeFile(authoringPath, authoring.replace("initialStatus: proposed", `initialStatus: ${status}`));
      await assert.rejects(docsNewV2({ ...base, apply: false }), /blockers/u);
    }
    await writeFile(authoringPath, authoring);
    const preview = await docsNewV2({ ...base, apply: false });
    const before = await snapshot(root);
    const stale = await docsNewV2({ ...base, apply: true, expectedPlanDigest: `sha256:${"0".repeat(64)}` });
    assert.equal(stale.envelope.outcome, "authority-stale");
    assert.equal(await snapshot(root), before);
    const applied = await docsNewV2({ ...base, apply: true, expectedPlanDigest: preview.envelope.result.planDigest });
    assert.equal(applied.envelope.result.writeState, "applied");
    const result = applied.envelope.result;
    const index = join(root, result.reachability.indexPath);
    await writeFile(index, `${await readFile(index, "utf8")}\n[Pending](blocker.md)\n${result.reachability.markdownLink}\n`);
    const check = await docsCheckV2(request);
    assert.equal(check.exitCode, 0, JSON.stringify(check));
    const documentPath = join(root, result.documentPath);
    const document = await readFile(documentPath, "utf8");
    for (const status of ["accepted", "active"]) {
      await writeFile(documentPath, document.replace("status: proposed", `status: ${status}`));
      const blocked = await docsCheckV2(request);
      assert.equal(blocked.exitCode, 1, JSON.stringify(blocked));
      assert.match(JSON.stringify(blocked.envelope.diagnostics), /blocker/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
