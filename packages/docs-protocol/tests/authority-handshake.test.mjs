import assert from "node:assert/strict";
import test from "node:test";

import { catalogMatchesExpectedPostimage, planAuthorityStable } from "../dist/features/portable-documentation/application/authority-handshake.js";

const profileDigest = `sha256:${"1".repeat(64)}`;
const preimageDigest = `sha256:${"2".repeat(64)}`;
const postimageDigest = `sha256:${"3".repeat(64)}`;

function plan() {
  return {
    schemaVersion: 2,
    authority: {
      profileSemanticDigest: profileDigest,
      catalogPreimageSemanticDigest: preimageDigest,
      expectedCatalogPostimageSemanticDigest: postimageDigest
    }
  };
}

function snapshot(catalogDigest) {
  return {
    catalog: { semanticDigest: catalogDigest },
    description: { semanticDigest: profileDigest }
  };
}

test("accepts a stable preimage or exact postimage and rejects transitions", () => {
  assert.equal(planAuthorityStable(plan(), snapshot(preimageDigest), snapshot(preimageDigest)), true);
  assert.equal(planAuthorityStable(plan(), snapshot(postimageDigest), snapshot(postimageDigest)), true);
  assert.equal(planAuthorityStable(plan(), snapshot(preimageDigest), snapshot(postimageDigest)), false);
  assert.equal(planAuthorityStable(plan(), snapshot(postimageDigest), snapshot(preimageDigest)), false);
  assert.equal(planAuthorityStable(plan(), snapshot(`sha256:${"4".repeat(64)}`), snapshot(`sha256:${"4".repeat(64)}`)), false);
});

test("untyped callers cannot bypass authority checks with another Plan generation", () => {
  for (const schemaVersion of [1, 3, "2", null, undefined]) {
    const foreign = { ...plan(), schemaVersion };
    assert.equal(planAuthorityStable(foreign, snapshot(preimageDigest), snapshot(preimageDigest)), false);
    assert.equal(catalogMatchesExpectedPostimage(foreign, snapshot(postimageDigest).catalog), false);
  }
  assert.equal(catalogMatchesExpectedPostimage(plan(), snapshot(postimageDigest).catalog), true);
});
