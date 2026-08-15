import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const cli = new URL("../dist/cli.js", import.meta.url);
const fixture = new URL("./fixtures/qualification", import.meta.url).pathname;

test("help succeeds through one pnpm-style separator", async () => {
  const result = await execute(process.execPath, [cli.pathname, "--", "--help"]);
  assert.match(result.stdout, /^Usage: agent-teams-docs/u);
  assert.equal(result.stderr, "");
});

test("new subcommand help documents the explicit mutation boundary", async () => {
  const result = await execute(process.execPath, [cli.pathname, "new", "--help"]);
  assert.match(result.stdout, /\(--dry-run\|--apply\)/u);
  assert.match(result.stdout, /--blocked-by/u);
});

test("human info and zero-match find expose useful authoring context", async () => {
  const info = await execute(process.execPath, [cli.pathname, "info", "--consumer", fixture]);
  assert.match(info.stdout, /Project: docs-protocol-qualification/u);
  assert.match(info.stdout, /Type adr \| initial proposed \| owners architecture\/tooling/u);
  assert.match(info.stdout, /identity adr-four-digits \| placement collection/u);

  const empty = await execute(process.execPath, [cli.pathname, "find", "--consumer", fixture, "--id", "ADR-9999"]);
  assert.match(empty.stdout, /docs\.find: success/u);
  assert.match(empty.stdout, /Matches: 0/u);
});
