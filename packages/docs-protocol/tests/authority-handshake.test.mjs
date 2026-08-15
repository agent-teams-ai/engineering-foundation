import assert from "node:assert/strict";
import test from "node:test";

import { planAuthorityStable } from "../dist/application/authority-handshake.js";

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
