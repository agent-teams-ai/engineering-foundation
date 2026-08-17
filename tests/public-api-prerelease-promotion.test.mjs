import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { promotePublicApiBaselines } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/promote-public-api-baselines.js";
import { cliPath, withPublicApiFixture } from "./support/capability-fixtures.mjs";
import { ROOT_STABLE_ITEM, sha256 } from "./support/public-api-fixtures.mjs";

const packagePolicy = Object.freeze({
  packageName: "@fixture/public-api",
  packageRoot: "packages/library",
  manifestPath: "packages/library/package.json",
  entrypoints: [{ exportPath: ".", declarationEntryPoint: "packages/library/dist/index.d.ts" }],
  nonTypeExports: [],
  tsconfigPath: "packages/library/tsconfig.json",
  releasedBaselinePath: "architecture/public-api/public-api.json",
  approvedBreakingChanges: [],
});
const released = Object.freeze({
  schemaVersion: 1,
  packageName: packagePolicy.packageName,
  packageVersion: "0.17.0-rc.0",
  extractorVersion: "7.58.12",
  entrypoints: [{ exportPath: ".", items: [] }],
});
const current = Object.freeze({
  ...released,
  packageVersion: "0.17.0-rc.1",
  entrypoints: [{ exportPath: ".", items: [ROOT_STABLE_ITEM] }],
});
const input = Object.freeze({
  consumerRoot: "/fixture",
  policy: {
    schemaVersion: 1,
    acceptedDecisionBaselinePath: "architecture/decisions/accepted-decisions.json",
    changesetDirectory: ".changeset",
    packages: [packagePolicy],
  },
});

function dependencies(
  { initialVersion, releasedSnapshot = released, currentSnapshot = current },
  writeReleasedBaseline,
) {
  return {
    extractor: { async extract() { return currentSnapshot; } },
    fingerprint: { sha256 },
    repository: {
      async readReleasedBaseline() { return releasedSnapshot; },
      async readReleaseEvidence() {
        return {
          packageName: packagePolicy.packageName,
          packageVersion: currentSnapshot.packageVersion,
          prereleaseInitialVersion: initialVersion,
          prereleaseTag: "rc",
        };
      },
      writeReleasedBaseline,
    },
    acceptedDecisionEvidence: {
      async readAcceptedDecisionEvidence() {
        return { acceptedDecisionIds: [], acceptedDecisionPaths: [] };
      },
    },
  };
}

test("uses the Changesets initial version within one numbered prerelease train", async () => {
  const writes = [];
  const promoted = await promotePublicApiBaselines(
    input,
    dependencies({ initialVersion: "0.16.1" }, async (...args) => { writes.push(args); }),
  );

  assert.equal(promoted[0].packageVersion, current.packageVersion);
  assert.equal(writes.length, 1);
});

test("rejects an insufficient numbered prerelease version line", async () => {
  const patchReleased = { ...released, packageVersion: "0.16.2-rc.0" };
  const patchCurrent = { ...current, packageVersion: "0.16.2-rc.1" };
  await assert.rejects(
    promotePublicApiBaselines(
      input,
      dependencies(
        {
          initialVersion: "0.16.1",
          releasedSnapshot: patchReleased,
          currentSnapshot: patchCurrent,
        },
        async () => { throw new Error("must not write"); },
      ),
    ),
    (error) => error?.problem?.code === "PUBLIC_API_BASELINE_PROMOTION_VERSION_INSUFFICIENT",
  );
});

test("reads the exact initial version from strict Changesets prerelease state", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const baselinePath = join(
      consumerRoot,
      "architecture",
      "public-api",
      "public-api.json",
    );
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    baseline.packageVersion = "1.3.0-rc.0";
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

    const manifestPath = join(consumerRoot, "packages", "library", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "1.3.0-rc.1";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(
      join(consumerRoot, "packages", "library", "dist", "index.d.ts"),
      [
        "export declare function added(): void;",
        "export declare function stable(value: string): string;",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(consumerRoot, ".changeset", "pre.json"),
      `${JSON.stringify({
        mode: "pre",
        tag: "rc",
        initialVersions: { "@fixture/public-api": "1.2.3" },
        changesets: [],
      }, null, 2)}\n`,
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [cliPath, "public-api-promote-release", "--consumer", consumerRoot, "--json"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).promoted[0].packageVersion, "1.3.0-rc.1");
  });
});
