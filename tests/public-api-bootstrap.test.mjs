import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { cliPath, withPublicApiFixture } from "./support/capability-fixtures.mjs";

async function prepareInitialPackage(consumerRoot) {
  const packagePath = join(consumerRoot, "packages", "library", "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  manifest.version = "0.0.0";
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(
    join(consumerRoot, ".changeset", "initial-public-api.md"),
    '---\n"@fixture/public-api": minor\n---\n\nAdd the initial public API.\n',
    "utf8",
  );
  return join(consumerRoot, "architecture", "public-api", "public-api.json");
}

function promote(consumerRoot) {
  return spawnSync(
    process.execPath,
    [cliPath, "public-api-promote-release", "--consumer", consumerRoot, "--json"],
    { encoding: "utf8" },
  );
}

test("CLI creates and replays a deterministic baseline for a new unreleased package", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const baselinePath = await prepareInitialPackage(consumerRoot);
    await unlink(baselinePath);

    const initial = promote(consumerRoot);
    assert.equal(initial.status, 0, initial.stdout);
    const initialBytes = await readFile(baselinePath, "utf8");
    const baseline = JSON.parse(initialBytes);
    assert.equal(baseline.packageName, "@fixture/public-api");
    assert.equal(baseline.packageVersion, "0.0.0");
    assert.deepEqual(baseline.entrypoints.map(({ exportPath }) => exportPath), ["."]);

    const replay = promote(consumerRoot);
    assert.equal(replay.status, 0, replay.stdout);
    assert.deepEqual(JSON.parse(replay.stdout).promoted, []);
    assert.equal(await readFile(baselinePath, "utf8"), initialBytes);
  });
});

test("CLI never bootstraps through a baseline symlink", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const baselinePath = await prepareInitialPackage(consumerRoot);
    const outsidePath = join(consumerRoot, "outside-baseline.json");
    const outsideBytes = '{"sentinel":true}\n';
    await writeFile(outsidePath, outsideBytes, "utf8");
    await unlink(baselinePath);
    await symlink(outsidePath, baselinePath);

    const result = promote(consumerRoot);

    assert.equal(result.status, 2, result.stdout);
    assert.equal(
      JSON.parse(result.stdout).error.code,
      "PUBLIC_API_EVIDENCE_SYMLINK_PROHIBITED",
    );
    assert.equal(await readFile(outsidePath, "utf8"), outsideBytes);
  });
});
