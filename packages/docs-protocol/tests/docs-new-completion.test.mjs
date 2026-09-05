import assert from "node:assert/strict";
import test from "node:test";

import { completeDocsNewApply } from "../dist/features/portable-documentation/application/docs-new-completion.js";

const plan = {
  destination: "docs/decisions/0083-tenant-isolation.md",
  authority: { expectedCatalogPostimageSemanticDigest: `sha256:${"7".repeat(64)}` }
};
const receipt = { outcome: "applied" };
const foundation = {
  async buildCatalog() { return { semanticDigest: plan.authority.expectedCatalogPostimageSemanticDigest }; }
};
const base = {
  codeAnchors: [{ pattern: "src/required.ts", enforcement: "required" }],
  consumerRoot: ".",
  diagnostics: [],
  foundation,
  outcome: "success",
  plan,
  profilePath: "architecture/foundation/document-authoring.yaml",
  reachability: { state: "not-required", reason: "fixture" },
  receipt
};

test("required anchor drift after publication reports published recovery state without reachability", async () => {
  const result = await completeDocsNewApply({ ...base, anchors: { async matchedPatterns() { return []; } } });
  assert.equal(result.outcome, "recovery-required");
  assert.equal(result.writeState, "published-recovery-required");
  assert.equal(result.reachability, undefined);
  assert.equal(result.diagnostics.at(-1).ruleId, "docs.code-anchor.required-stale-after-publication");
});

test("post-publication anchor inspection failure preserves truthful published recovery state", async () => {
  const result = await completeDocsNewApply({
    ...base,
    anchors: { async matchedPatterns() { throw new RangeError("bounded corpus exceeded"); } }
  });
  assert.equal(result.outcome, "recovery-required");
  assert.equal(result.writeState, "published-recovery-required");
  assert.equal(result.reachability, undefined);
  assert.equal(result.diagnostics.at(-1).ruleId, "docs.code-anchor.post-publication-inspection-failed");
});
