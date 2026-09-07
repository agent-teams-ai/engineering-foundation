import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareRegistryDocsProtocolMcpFixture,
} from "../scripts/registry-docs-protocol-mcp-e2e.mjs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function successfulCheck() {
  return {
    outcome: "success",
    diagnostics: [],
    result: { valid: true },
  };
}

test("Windows fixture loads the built renderer and passes the real read-only check", async (t) => {
  const consumerRoot = await realpath(await mkdtemp(join(tmpdir(), "registry-renderer-test-")));
  t.after(() => rm(consumerRoot, { recursive: true, force: true }));
  const installedDocsRoot = join(repositoryRoot, "packages", "docs-protocol");
  const result = await prepareRegistryDocsProtocolMcpFixture({
    consumerRoot,
    installedDocsRoot,
    docsCli: join(installedDocsRoot, "dist", "cli.js"),
  }, { platform: "win32" });
  assert.equal(result.documentId, "docs.tutorials.index");
  assert.match(await readFile(join(consumerRoot, "AGENTS.md"), "utf8"), /docs/iu);
});

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

test("registry harness directly qualifies every public read-only CLI command", async () => {
  const source = await readFile(
    `${repositoryRoot}/scripts/registry-docs-protocol-mcp-e2e.mjs`,
    "utf8",
  );
  assert.match(source, /verifyRegistryDocsProtocolCli/u);
  for (const command of ["info", "find", "context", "check"]) {
    assert.match(source, new RegExp(`\\[?"${command}"`, "u"));
    assert.match(source, new RegExp(`docs\\.${command}`, "u"));
  }
  assert.match(source, /read-only CLI commands must not write/u);
});
