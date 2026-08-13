import assert from "node:assert/strict";
import test from "node:test";

import {
  changesetsPublishArguments,
  releasePublishPolicy,
} from "../scripts/release-publish.mjs";

test("routes an exact Changesets rc version to the rc npm dist-tag", () => {
  assert.deepEqual(
    releasePublishPolicy({
      packageVersion: "0.16.0-rc.0",
      preState: { mode: "pre", tag: "rc" },
    }),
    { tag: "rc" },
  );
  assert.deepEqual(changesetsPublishArguments(), ["changeset", "publish"]);
});

test("keeps ordinary stable releases on the default dist-tag", () => {
  assert.deepEqual(
    releasePublishPolicy({ packageVersion: "0.16.0", preState: undefined }),
    { tag: undefined },
  );
  assert.deepEqual(changesetsPublishArguments(), ["changeset", "publish"]);
});

for (const scenario of [
  { name: "prerelease without state", version: "0.16.0-rc.0", state: undefined },
  { name: "wrong prerelease tag", version: "0.16.0-beta.0", state: { mode: "pre", tag: "beta" } },
  { name: "malformed rc version", version: "0.16.0-rc.next", state: { mode: "pre", tag: "rc" } },
  { name: "stable version in pre mode", version: "0.16.0", state: { mode: "pre", tag: "rc" } },
  { name: "exited pre mode", version: "0.16.0-rc.0", state: { mode: "exit", tag: "rc" } },
]) {
  test(`fails closed for ${scenario.name}`, () => {
    assert.throws(
      () => releasePublishPolicy({ packageVersion: scenario.version, preState: scenario.state }),
      /publication|Prerelease/u,
    );
  });
}
