import assert from "node:assert/strict";
import { join } from "node:path";
import { type Row } from "../ef70-managed-campaign/campaign-io.ts";
import { bytes, inventory, retainAt, selected } from "./files.ts";
import { assertTargetImages, type ProofContext } from "./proofs.ts";
import type { TransitionResult } from "./transition.ts";

export function retainActualOutput(context: ProofContext, transition: TransitionResult): Row {
  const { evidence } = context,
    c = evidence.config;
  assertTargetImages(context, transition.preparation, "output-custody");
  const changed = evidence
    .command(
      "actual-changed-paths",
      "/usr/bin/git",
      [
        "--no-replace-objects",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-only",
        "-z",
        c.sourceRevision,
        "--",
      ],
      c.consumer,
    )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .toSorted();
  const managed = transition.preparation.operations.map((operation) => operation.path).toSorted();
  assert.deepEqual(
    changed,
    managed,
    "Export must contain only actual owner-produced managed changes",
  );
  const images = inventory(c.consumer),
    exported: Row[] = [];
  for (const path of changed) {
    const image = images.find((entry) => entry.path === path);
    assert(image && image.kind === "file");
    const content = bytes(join(c.consumer, path));
    const retained = retainAt(c.roots.evidenceRoot, "consumer-files/" + path, content);
    exported.push({
      ...image,
      sourceRevision: c.sourceRevision,
      gitMode: image.mode === 0o644 ? "100644" : image.mode === 0o755 ? "100755" : "unsupported",
      retained: selected(retained),
    });
  }
  const patch = evidence.command(
    "actual-managed-patch",
    "/usr/bin/git",
    [
      "--no-replace-objects",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--binary",
      "--full-index",
      c.sourceRevision,
      "--",
    ],
    c.consumer,
  );
  assert(patch.length > 0);
  const patchPath = retainAt(c.roots.evidenceRoot, "actual-managed.patch", patch);
  const raw = evidence.command(
    "actual-managed-raw",
    "/usr/bin/git",
    [
      "--no-replace-objects",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--raw",
      "--full-index",
      c.sourceRevision,
      "--",
    ],
    c.consumer,
  );
  retainAt(c.roots.evidenceRoot, "actual-managed.raw", raw);
  const manifest = {
    sourceRevision: c.sourceRevision,
    sourceTree: context.source.tree,
    files: exported,
    patch: selected(patchPath),
    origin: "Actual successful published-controller prepare/finalize/installed-check execution.",
    transfer:
      "Retain real bytes and modes with sourceC lineage. A downloaded preparation does not transfer original root identity.",
    recoveryBoundary:
      "Original preparation/current-selection recovery remains subject to actual C ancestry on the PR branch; no post-squash-main ancestry claim.",
    qualificationBoundary:
      "No trusted Docs receipt, CANARY, observed-state update, final native CI or merge is claimed.",
  };
  const manifestPath = evidence.output("consumer-output-manifest", manifest);
  return { manifest: selected(manifestPath), ...manifest };
}
