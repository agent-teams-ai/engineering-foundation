import assert from "node:assert/strict";
import test from "node:test";

import {
  registryPublicationTag,
  registryPublishArguments,
} from "../scripts/registry-publication-policy.mjs";

test("keeps stable hermetic registry publications on the default tag", () => {
  assert.equal(registryPublicationTag("0.16.0"), undefined);
  assert.doesNotMatch(
    registryPublishArguments({
      archivePath: "package.tgz",
      registryUrl: "http://127.0.0.1:4873",
      version: "0.16.0",
    }).join(" "),
    /--tag/u,
  );
});

test("routes prerelease publications to a non-latest hermetic tag", () => {
  assert.equal(registryPublicationTag("0.16.0-rc.0"), "e2e-prerelease");
  assert.deepEqual(
    registryPublishArguments({
      archivePath: "package.tgz",
      registryUrl: "http://127.0.0.1:4873",
      version: "0.16.0-rc.0",
    }).slice(-2),
    ["--tag", "e2e-prerelease"],
  );
});

test("rejects a missing package version", () => {
  assert.throws(
    () => registryPublicationTag(""),
    /requires a package version/u,
  );
});
