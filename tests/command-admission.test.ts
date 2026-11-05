import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(
  new URL("../packages/engineering-foundation/dist/cli.js", import.meta.url),
);

function invoke(args: readonly string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 32_768,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function invalidJson(stdout: string): string {
  // Parsing the entire stream rejects a second value or incidental stdout.
  const value: unknown = JSON.parse(stdout);
  assert.ok(typeof value === "object" && value !== null);
  assert.ok("schemaVersion" in value && value.schemaVersion === 1);
  assert.ok("outcome" in value && value.outcome === "invalid-input");
  assert.ok("error" in value && typeof value.error === "object" && value.error !== null);
  assert.ok("code" in value.error && value.error.code === "CONSUMER_INVALID");
  assert.ok("retryable" in value.error && value.error.retryable === false);
  assert.ok("message" in value.error && typeof value.error.message === "string");
  return value.error.message;
}

test("positional and command tokens do not request JSON error output", () => {
  for (const args of [
    ["status", "--", "--json"],
    ["status", "--", "--format", "json"],
    ["check", "--unknown", "--", "--json"],
    ["--json"],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
    assert.match(result.stderr, /^CONSUMER_INVALID: /u, args.join(" "));
  }
});

test("malformed invocations retain first-error precedence and recognized JSON intent", () => {
  const cases: readonly [readonly string[], string][] = [
    [["--unknown", "--format", "json"], "Unknown option: --unknown."],
    [["--format", "json", "--unknown"], "Unknown option: --unknown."],
    [["--consumer", "--json"], "--consumer requires a value."],
    [["--config", "--format", "json"], "--config requires a value."],
    [["--format", "xml", "--json"], "--format requires json or text."],
    [["--format", "text", "--json"], "--json or --format may be specified only once."],
    [["--json", "--format", "text"], "--json or --format may be specified only once."],
    [["--format", "json", "--format", "json"], "--json or --format may be specified only once."],
    [["--format", "json", "--", "--json", "extra"], "check accepts at most 1 positional argument."],
  ];
  for (const [args, message] of cases) {
    const result = invoke(["check", ...args]);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stderr, "", args.join(" "));
    assert.equal(invalidJson(result.stdout), message, args.join(" "));
  }
});

test("text requests and consumed scalar values retain text errors", () => {
  const cases: readonly [readonly string[], string][] = [
    [["check", "--unknown", "--format", "text"], "Unknown option: --unknown."],
    [
      ["check", "--format", "text", "--format", "text"],
      "--json or --format may be specified only once.",
    ],
    [
      ["check", "--config", "./--json"],
      "--config is supported only by scaffold-plan, public-api-audit or baseline.",
    ],
    [
      ["check", "--base", "branch/--json"],
      "--base is supported only by agent-workflow changed or check-changed.",
    ],
  ];
  for (const [args, message] of cases) {
    const result = invoke(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
    assert.equal(result.stderr, `CONSUMER_INVALID: ${message}\n`, args.join(" "));
  }
});
