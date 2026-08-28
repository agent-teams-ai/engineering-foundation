import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareRegistryDocsProtocolMcpFixture,
} from "../scripts/registry-docs-protocol-mcp-e2e.mjs";

function successfulCheck() {
  return {
    outcome: "success",
    diagnostics: [],
    result: { valid: true },
  };
}

test("win32 registry fixture uses installed package assets without init or new apply", async () => {
  const calls = [];
  const materialized = [];
  const expected = await prepareRegistryDocsProtocolMcpFixture({
    consumerRoot: "C:\\bounded\\registry-fixture",
    docsCli: "C:\\installed\\docs-cli.js",
    installedDocsRoot: "C:\\installed\\docs-protocol",
  }, {
    platform: "win32",
    executeJson: async (_cliPath, _consumerRoot, arguments_) => {
      calls.push(arguments_);
      return successfulCheck();
    },
    materializePortableFixture: async (...arguments_) => materialized.push(arguments_),
  });

  assert.equal(materialized.length, 1);
  assert.deepEqual(calls.map(([command]) => command), ["check"]);
  assert.equal(calls.some((arguments_) => arguments_.includes("--apply")), false);
  assert.equal(expected.documentId, "docs.tutorials.index");
});

test("POSIX registry fixture retains installed init and new apply qualification", async () => {
  const calls = [];
  let materialized = false;
  const executeJson = async (_cliPath, _consumerRoot, arguments_) => {
    calls.push(arguments_);
    if (arguments_[0] === "check") {
      return successfulCheck();
    }
    return {
      outcome: "success",
      diagnostics: [],
      result: {
        planDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        writeState: arguments_.includes("--dry-run") ? "preview" : "applied",
      },
    };
  };
  const expected = await prepareRegistryDocsProtocolMcpFixture({
    consumerRoot: "/bounded/registry-fixture",
    docsCli: "/installed/docs-cli.js",
    installedDocsRoot: "/installed/docs-protocol",
  }, {
    platform: "linux",
    executeJson,
    materializePortableFixture: async () => {
      materialized = true;
    },
  });

  assert.equal(materialized, false);
  assert.deepEqual(calls.map(([command]) => command), ["init", "init", "new", "check"]);
  assert.equal(calls.filter((arguments_) => arguments_.includes("--apply")).length, 2);
  assert.equal(expected.documentId, "docs.tutorial.registry-mcp");
});
