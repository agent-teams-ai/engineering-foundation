import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("consumer JSON mode survives bounded argv failures without accepting aliases", () => {
  const cliPath = join(import.meta.dirname, "..", "dist", "cli.js");
  const invoke = (args) => spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_PROXY: "*" },
  });
  for (const args of [
    ["check", "--consumer", "--json"],
    ["check", "x".repeat(4097), "--json"],
    ["check", ...Array.from({ length: 31 }, (_value, index) => `arg-${index}`), "--json"],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 2, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.outcome, "blocked");
    assert.equal(envelope.issues[0].code, "DOCS_CONSUMER_CLI_INVALID");
  }

  const ambiguous = invoke(["check", "--json=true"]);
  assert.equal(ambiguous.status, 2, ambiguous.stderr);
  assert.match(ambiguous.stdout, /^consumer\.check: blocked\n/u);

  const formerPrefix = invoke(["consumer", "check", "--json"]);
  assert.equal(formerPrefix.status, 2, formerPrefix.stderr);
  const formerPrefixEnvelope = JSON.parse(formerPrefix.stdout);
  assert.equal(formerPrefixEnvelope.command, "consumer.check");
  assert.equal(formerPrefixEnvelope.outcome, "blocked");
  assert.equal(formerPrefixEnvelope.issues[0].code, "DOCS_CONSUMER_CLI_INVALID");

  const missingGeneration = invoke(["upgrade", "--to", "docs-v2-target", "--json"]);
  assert.equal(missingGeneration.status, 2, missingGeneration.stderr);
  const missingGenerationEnvelope = JSON.parse(missingGeneration.stdout);
  assert.equal(missingGenerationEnvelope.issues[0].code, "DOCS_CONSUMER_CLI_INVALID");
  assert.match(missingGenerationEnvelope.issues[0].message, /--target-generation/u);

  const urls = [
    "https://registry.example/archive.tgz?key=/opt/object&expires=123",
    "http://registry.example/archive.tgz?key=/tmp/object&expires=123"
  ];
  const queryFailure = invoke(["check", "--json", ...urls,
    "store=/node26-native-test-tmp/cli-query-NEWTEST/store/v11", "node_modules/.pnpm"]);
  assert.equal(queryFailure.status, 2, queryFailure.stderr);
  assert.equal(queryFailure.stderr, "");
  assert.deepEqual(JSON.parse(queryFailure.stdout), {
    schemaVersion: 1,
    command: "consumer.check",
    outcome: "blocked",
    issues: [{ code: "DOCS_CONSUMER_CLI_INVALID", severity: "error", subject: "check",
      message: `Unknown consumer arguments: ${urls.join(" ")} store=<local-path> node_modules/.pnpm.` }]
  });
});
