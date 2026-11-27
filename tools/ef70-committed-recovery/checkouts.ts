import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { row, type Row } from "../ef70-managed-campaign/campaign-io.ts";
import { type SourceAdmission } from "../ef70-managed-adoption/admission.ts";
import { AdoptionEvidence } from "../ef70-managed-adoption/evidence.ts";
import {
  bytes,
  inventory,
  json,
  regularImage,
  rootIdentity,
  type FileImage,
} from "../ef70-managed-adoption/files.ts";
import { gitSha, sourceCohort } from "../ef70-managed-adoption/configuration.ts";
import { adoptionHarness } from "./configuration.ts";
import type { OriginalArchive } from "./artifact-intake.ts";

export const profilePath = "architecture/foundation/docs-consumer-integration.json";
export function assertCheckout(
  evidence: AdoptionEvidence,
  root: string,
  revision: string,
  label: string,
): void {
  assert.equal(evidence.git(root, label + "-head", ["rev-parse", "HEAD"]), revision);
  assert.equal(
    evidence.git(root, label + "-clean", ["status", "--porcelain=v1", "--untracked-files=all"]),
    "",
  );
  assert.equal(
    evidence.git(root, label + "-shallow", ["rev-parse", "--is-shallow-repository"]),
    "false",
  );
}
export function trackedImages(
  evidence: AdoptionEvidence,
  root: string,
  label: string,
): FileImage[] {
  const images = inventory(root);
  const raw = evidence.command(
    label + "-index",
    "/usr/bin/git",
    ["--no-replace-objects", "ls-files", "--stage", "-z"],
    root,
  );
  const index = raw
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(100644|100755) ([0-9a-f]{40}) 0\t(.+)$/u.exec(entry);
      assert(match, "Only ordinary stage0 regular source files");
      return { mode: match[1]!, path: match[3]! };
    })
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  assert.deepEqual(
    images.map((image) => image.path),
    index.map((entry) => entry.path),
    "Ignored/untracked nondependency images",
  );
  for (const [i, entry] of index.entries()) {
    assert.equal(images[i]!.kind, "file");
    assert.equal(images[i]!.mode, entry.mode === "100644" ? 0o644 : 0o755);
  }
  evidence.record(label + "-full-inventory", images);
  return images;
}
export function captureCheckout(
  evidence: AdoptionEvidence,
  root: string,
  label: string,
): SourceAdmission {
  const pin = regularImage(join(root, ".node-version"));
  assert.equal(bytes(pin.path).toString("utf8"), "26.12.1\n");
  assert.equal(pin.mode, 0o644);
  const profile = json(join(root, profilePath));
  assert.deepEqual(profile["repository"], {
    provider: "github",
    id: "1333298097",
    nameWithOwner: "agent-teams-ai/extension-foundation",
  });
  return {
    pin,
    profile,
    identity: rootIdentity(root),
    images: trackedImages(evidence, root, label),
    tree: evidence.git(root, label + "-tree", ["rev-parse", "HEAD^{tree}"]),
  };
}
export function cloneFixture(evidence: AdoptionEvidence, revision: string, name: string): string {
  const root = join(evidence.config.roots.root, name);
  assert(!existsSync(root));
  evidence.command(
    name + "-clone",
    "/usr/bin/git",
    ["clone", "--no-hardlinks", "--no-checkout", evidence.config.consumer, root],
    evidence.config.harness,
  );
  evidence.git(root, name + "-origin", [
    "remote",
    "set-url",
    "origin",
    "https://github.com/agent-teams-ai/extension-foundation.git",
  ]);
  evidence.git(root, name + "-checkout", ["checkout", "--detach", revision]);
  assertCheckout(evidence, root, revision, name);
  return root;
}
export function admitCheckouts(evidence: AdoptionEvidence, archive: OriginalArchive) {
  const c = evidence.config;
  for (const [root, revision, name] of [
    [c.consumer, c.sourceRevision, "extension-foundation"],
    [c.central, c.authorityRevision, ".github"],
    [c.harness, c.harnessRevision, "engineering-foundation"],
  ] as const) {
    assertCheckout(evidence, root, revision, name.replace(".", "central"));
    const origin = evidence.git(root, name.replace(".", "central") + "-origin", [
      "remote",
      "get-url",
      "origin",
    ]);
    assert(
      [
        "https://github.com/agent-teams-ai/" + name,
        "https://github.com/agent-teams-ai/" + name + ".git",
      ].includes(origin),
    );
  }
  evidence.git(c.harness, "h3-parent-ancestry", [
    "merge-base",
    "--is-ancestor",
    adoptionHarness,
    c.harnessRevision,
  ]);
  const originalRevision = gitSha(archive.marker["sourceRevision"], "Actual original C");
  evidence.git(c.consumer, "original-c-ancestor-current-f", [
    "merge-base",
    "--is-ancestor",
    originalRevision,
    c.sourceRevision,
  ]);
  assert(
    !existsSync(join(c.consumer, "node_modules")) &&
      !existsSync(join(c.consumer, ".agent-teams-local")),
  );
  const current = captureCheckout(evidence, c.consumer, "current-f");
  verifyLineage((args) => evidence.git(c.consumer, "current-lineage", args), {
    originalRevision,
    originalTree: gitSha(archive.marker["sourceTree"], "Original tree"),
    currentRevision: c.sourceRevision,
    currentTree: current.tree,
  });
  assert.equal(current.profile["schemaVersion"], 4);
  assert.equal(row(current.profile["cohort"], "Current target")["cohortId"], c.targetCohort);
  assert.equal(json(join(c.consumer, "package.json"))["packageManager"], "pnpm@11.20.0");
  const originalRoot = cloneFixture(evidence, originalRevision, "original-source-cache");
  const original = captureCheckout(evidence, originalRoot, "original-c");
  assert.equal(original.tree, archive.marker["sourceTree"]);
  assert.equal(original.profile["schemaVersion"], 3);
  assert.equal(row(original.profile["cohort"], "Original source")["cohortId"], sourceCohort);
  assert.equal(json(join(originalRoot, "package.json"))["packageManager"], "pnpm@11.18.0");
  evidence.record("current-and-original-admission", {
    currentRevision: c.sourceRevision,
    current,
    originalRevision,
    original,
    scope:
      "Original P physical root is historical. This current checkout has a fresh real identity.",
  });
  return { current, original, originalRevision, originalRoot };
}
export function assertForeignImages(
  before: readonly FileImage[],
  after: readonly FileImage[],
  managedPaths: readonly string[],
): void {
  const managed = new Set(managedPaths);
  assert.deepEqual(
    after.filter((image) => !managed.has(image.path)),
    before.filter((image) => !managed.has(image.path)),
    "Independent final-PR images changed",
  );
}
export function assertCurrentHead(
  actual: Row,
  expected: { readonly revision: string; readonly tree: string },
): void {
  assert.equal(actual["revision"], expected.revision);
  assert.equal(actual["tree"], expected.tree);
}

export function verifyLineage(
  git: (args: readonly string[]) => string,
  expected: {
    readonly originalRevision: string;
    readonly originalTree: string;
    readonly currentRevision: string;
    readonly currentTree: string;
  },
): void {
  git(["merge-base", "--is-ancestor", expected.originalRevision, expected.currentRevision]);
  assert.equal(git(["rev-parse", expected.originalRevision + "^{tree}"]), expected.originalTree);
  assertCurrentHead(
    { revision: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]) },
    { revision: expected.currentRevision, tree: expected.currentTree },
  );
}
