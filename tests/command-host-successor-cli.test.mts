import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL(
  "../packages/engineering-foundation/dist/cli.js",
  import.meta.url,
));

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 32_768,
  });
}

// RED regression: a correctly composed successor becomes unreachable through
// the installed command host, despite passing capability-level fixtures.
test("command host advertises both changed workflow routes", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /agent-workflow changed/u);
  assert.match(result.stdout, /agent-workflow check-changed/u);
});

// RED regression: target paths silently narrow the repository-wide successor
// or reach config loading instead of being rejected at the command boundary.
test("command host rejects target paths before either changed route loads configuration", () => {
  for (const route of ["changed", "check-changed"]) {
    const result = runCli(["agent-workflow", route, "src/example.ts"]);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`agent-workflow ${route} does not accept a target path\\.`, "u"));
  }
});

// RED regression: widening successor --base admission also admits the flag on
// the instruction route, changing its preserved command contract.
test("command host keeps base selection unavailable on workflow instructions", () => {
  const result = runCli(["agent-workflow", "instructions", "AGENTS.md", "--base", "HEAD"]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--base is supported only by agent-workflow changed or check-changed/u);
});
