import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// These suites share the established declaration fixture as inert repository data.
const fixture = fileURLToPath(new URL("../../../../tests/fixtures/workspace-dependency-declarations/valid/", import.meta.url));
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export async function withFixture(callback) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foundation-dependency-aliases-")));
  try {
    await cp(fixture, root, { recursive: true });
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

export function check(consumerRoot, ...capabilities) {
  const result = spawnSync(process.execPath,
    [cli, "check", ...capabilities, "--consumer", consumerRoot, "--format", "json"],
    { encoding: "utf8" });
  assert.equal(result.stderr, "");
  return { result, report: JSON.parse(result.stdout) };
}
