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

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /attach requires a foundation repository or package path\./u,
  );
});
