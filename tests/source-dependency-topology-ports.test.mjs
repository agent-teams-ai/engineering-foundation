import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { foundationPackageRoot, inspectV2Topology, withCopiedFixture } from "./helpers/source-dependency-v2-fixture.mjs";

const distRoot = process.env.FOUNDATION_DIST_ROOT ?? join(foundationPackageRoot, "dist");
const files = await import(pathToFileURL(join(distRoot, "source-inventory/node.js")).href);
const defaults = { read: files.readContainedRegularFile };

test("source topology file port preserves Uint8Array evidence and its reader receiver", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const expected = await inspectV2Topology(consumerRoot);
    const calls = [];
    const fileReader = { calls, async read(input) {
      this.calls.push(input);
      return new Uint8Array(await defaults.read(input));
    } };
    const actual = await inspectV2Topology(consumerRoot, { fileReader });
    assert.deepEqual(actual, expected);
    const sourceCalls = calls.filter(({ candidate }) => !candidate.endsWith("package.json"));
    assert.deepEqual(sourceCalls.map(({ candidate }) => candidate).toSorted(),
      expected.sourceFiles.map(({ path }) => join(expected.canonicalConsumerRoot, path)).toSorted());
    assert.ok(calls.some(({ candidate }) => candidate.endsWith("package.json")));
    for (const call of calls) {
      assert.equal(call.root, expected.canonicalConsumerRoot);
      assert.equal(call.maxBytes, call.candidate.endsWith("package.json") ? 2 * 1024 * 1024 : 4 * 1024 * 1024);
    }
  });
});

for (const [failure, code] of [
  ["escape", "SOURCE_DIRECTORY_ESCAPE"], ["symlink", "SOURCE_SYMLINK_PROHIBITED"],
  ["changed", "SOURCE_FILESYSTEM_CHANGED"], ["invalid", "SOURCE_FILE_INVALID"],
  ["missing", "SOURCE_FILE_UNAVAILABLE"], ["unavailable", "SOURCE_FILE_UNAVAILABLE"],
]) {
  test(`source topology file port preserves ${failure} diagnostics`, async () => {
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      const fileReader = { async read(input) {
        if (input.candidate.endsWith("package.json")) { return defaults.read(input); }
        throw new files.ContainedFileReadError(failure);
      } };
      await assert.rejects(inspectV2Topology(consumerRoot, { fileReader }),
        ({ problem }) => problem?.code === code && problem.phase === "source-workspace-topology" && problem.retryable === false);
    });
  });
}

test("source topology file port propagates unexpected source failures without fallback", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const failure = new Error("selected source reader failure");
    const fileReader = { async read(input) {
      if (input.candidate.endsWith("package.json")) { return defaults.read(input); }
      throw failure;
    } };
    await assert.rejects(inspectV2Topology(consumerRoot, { fileReader }), (error) => error === failure);
  });
});

for (const [target, code] of [["source", "SOURCE_FILE_INVALID"], ["manifest", "PACKAGE_MANIFEST_INVALID"]]) {
  test(`source topology file port cannot bypass the ${target} byte limit`, async () => {
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      const fileReader = { async read(input) {
        const isManifest = input.candidate.endsWith("package.json");
        if (isManifest === (target === "manifest")) { return new Uint8Array(input.maxBytes + 1); }
        return defaults.read(input);
      } };
      await assert.rejects(inspectV2Topology(consumerRoot, { fileReader }),
        ({ problem }) => problem?.code === code);
    });
  });
}

test("source topology uses the selected YAML loader and propagates its failure without fallback", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const failure = new Error("selected manifest failure");
    const calls = [];
    let fileReads = 0;
    const fileReader = { async read() { fileReads += 1; throw new Error("unexpected file read"); } };
    const signal = new AbortController().signal;
    const workspaceManifestLoader = async (...args) => { calls.push(args); throw failure; };
    await assert.rejects(inspectV2Topology(consumerRoot, { fileReader, workspaceManifestLoader }, signal),
      (error) => error === failure);
    assert.deepEqual(calls, [[consumerRoot, "pnpm-workspace.yaml", "source-workspace-topology", signal]]);
    assert.equal(fileReads, 0);
  });
});

test("source topology cancellation precedes selected workspace and file readers", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    let reads = 0;
    const fileReader = { async read() { reads += 1; throw new Error("unexpected file read"); } };
    const workspaceManifestLoader = async () => { reads += 1; throw new Error("unexpected YAML read"); };
    await assert.rejects(inspectV2Topology(consumerRoot, { fileReader, workspaceManifestLoader }, AbortSignal.abort()),
      ({ problem }) => problem?.code === "EXECUTION_CANCELLED");
    assert.equal(reads, 0);
  });
});
