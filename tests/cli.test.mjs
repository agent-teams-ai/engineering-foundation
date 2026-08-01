import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(
  new URL(
    "../packages/engineering-foundation/dist/cli.js",
    import.meta.url,
  ),
);

test("ignores the package-manager argument separator", () => {
  const result = spawnSync(process.execPath, [cliPath, "attach", "--"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /^CONSUMER_INVALID: attach requires a foundation repository or package path\./u,
  );
});

test("uses the stable invalid-invocation exit code", () => {
  for (const commandArguments of [
    ["check", "--format", "xml"],
    ["check", "workspace.dependency-declarations", "extra"],
    ["check", "--unknown-option"],
    ["unknown-command"],
  ]) {
    const result = spawnSync(process.execPath, [cliPath, ...commandArguments], {
      encoding: "utf8",
    });

    assert.equal(
      result.status,
      2,
      `${commandArguments.join(" ")}: ${result.stderr}`,
    );
    assert.match(result.stderr, /^CONSUMER_INVALID:/u);
  }
});
