import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  assertArchiveSafety,
  inspectCompressedTarArchive,
} from "../scripts/pack-artifact-archive.mjs";
import { preparePackages } from "../scripts/prepare-package.mjs";
import { tarArchive } from "./pack-publishable-artifacts-support.mjs";

const FOUNDATION_PACKAGE = "@agent-teams/engineering-foundation";
const F3_PRODUCTION_MODULES = JSON.parse(
  await readFile(
    new URL("./fixtures/package-archive-budget/f3-production-modules.json", import.meta.url),
    "utf8",
  ),
);
const EXPECTED_F3_ARTIFACTS = F3_PRODUCTION_MODULES.productionModuleStems.flatMap((stem) =>
  F3_PRODUCTION_MODULES.compilerArtifacts.map((suffix) => `${stem}${suffix}`),
);
const EXPECTED_NEW_MODULE_ARTIFACTS = Object.freeze([
  "dist/local-mode/application/bun-registry-policy.d.ts",
  "dist/local-mode/application/bun-registry-policy.d.ts.map",
  "dist/local-mode/application/bun-registry-policy.js",
  "dist/local-mode/application/bun-registry-policy.js.map",
  "dist/local-mode/adapters/node/bun-registry-inspection.d.ts",
  "dist/local-mode/adapters/node/bun-registry-inspection.d.ts.map",
  "dist/local-mode/adapters/node/bun-registry-inspection.js",
  "dist/local-mode/adapters/node/bun-registry-inspection.js.map",
  "dist/features/configuration-input/application/static-host-command.d.ts",
  "dist/features/configuration-input/application/static-host-command.d.ts.map",
  "dist/features/configuration-input/application/static-host-command.js",
  "dist/features/configuration-input/application/static-host-command.js.map",
  "dist/capabilities/governance-architecture-decisions/adapters/outbound/filesystem/architecture-decision-baseline-replacement.d.ts",
  "dist/capabilities/governance-architecture-decisions/adapters/outbound/filesystem/architecture-decision-baseline-replacement.d.ts.map",
  "dist/capabilities/governance-architecture-decisions/adapters/outbound/filesystem/architecture-decision-baseline-replacement.js",
  "dist/capabilities/governance-architecture-decisions/adapters/outbound/filesystem/architecture-decision-baseline-replacement.js.map",
  "dist/capabilities/repository-agent-workflow/adapters/outbound/git/git-index-snapshot.d.ts",
  "dist/capabilities/repository-agent-workflow/adapters/outbound/git/git-index-snapshot.d.ts.map",
  "dist/capabilities/repository-agent-workflow/adapters/outbound/git/git-index-snapshot.js",
  "dist/capabilities/repository-agent-workflow/adapters/outbound/git/git-index-snapshot.js.map",
  "schemas/repository-agent-workflow/v2.schema.json",
  "schemas/workspace-dependency-declarations/v2.schema.json",
  "dist/capabilities/public-api-compatibility/adapters/inbound/configuration/load-native-tool-transition.d.ts",
  "dist/capabilities/public-api-compatibility/adapters/inbound/configuration/load-native-tool-transition.d.ts.map",
  "dist/capabilities/public-api-compatibility/adapters/inbound/configuration/load-native-tool-transition.js",
  "dist/capabilities/public-api-compatibility/adapters/inbound/configuration/load-native-tool-transition.js.map",
  "dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/native-tool-transition-content.d.ts",
  "dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/native-tool-transition-content.d.ts.map",
  "dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/native-tool-transition-content.js",
  "dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/native-tool-transition-content.js.map",
  "dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/native-transition-archive.d.ts",
  "dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/native-transition-archive.d.ts.map",
  "dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/native-transition-archive.js",
  "dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/native-transition-archive.js.map",
  "dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/observe-native-tool-transition.d.ts",
  "dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/observe-native-tool-transition.d.ts.map",
  "dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/observe-native-tool-transition.js",
  "dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/observe-native-tool-transition.js.map",
  "dist/capabilities/public-api-compatibility/application/model/native-tool-transition.d.ts",
  "dist/capabilities/public-api-compatibility/application/model/native-tool-transition.d.ts.map",
  "dist/capabilities/public-api-compatibility/application/model/native-tool-transition.js",
  "dist/capabilities/public-api-compatibility/application/model/native-tool-transition.js.map",
  "dist/capabilities/public-api-compatibility/application/policies/validate-native-tool-transition.d.ts",
  "dist/capabilities/public-api-compatibility/application/policies/validate-native-tool-transition.d.ts.map",
  "dist/capabilities/public-api-compatibility/application/policies/validate-native-tool-transition.js",
  "dist/capabilities/public-api-compatibility/application/policies/validate-native-tool-transition.js.map",
  "dist/capabilities/public-api-compatibility/application/ports/native-tool-transition.d.ts",
  "dist/capabilities/public-api-compatibility/application/ports/native-tool-transition.d.ts.map",
  "dist/capabilities/public-api-compatibility/application/ports/native-tool-transition.js",
  "dist/capabilities/public-api-compatibility/application/ports/native-tool-transition.js.map",
  "dist/capabilities/public-api-compatibility/application/use-cases/prepare-native-tool-transition.d.ts",
  "dist/capabilities/public-api-compatibility/application/use-cases/prepare-native-tool-transition.d.ts.map",
  "dist/capabilities/public-api-compatibility/application/use-cases/prepare-native-tool-transition.js",
  "dist/capabilities/public-api-compatibility/application/use-cases/prepare-native-tool-transition.js.map",
  "dist/capabilities/public-api-compatibility/native-transition-module.d.ts",
  "dist/capabilities/public-api-compatibility/native-transition-module.d.ts.map",
  "dist/capabilities/public-api-compatibility/native-transition-module.js",
  "dist/capabilities/public-api-compatibility/native-transition-module.js.map",
  "dist/capabilities/quality-gate-runner/adapters/outbound/bun/bun-package-script-executor.d.ts",
  "dist/capabilities/quality-gate-runner/adapters/outbound/bun/bun-package-script-executor.d.ts.map",
  "dist/capabilities/quality-gate-runner/adapters/outbound/bun/bun-package-script-executor.js",
  "dist/capabilities/quality-gate-runner/adapters/outbound/bun/bun-package-script-executor.js.map",
  "dist/capabilities/quality-gate-runner/composition/select-package-script-executor.d.ts",
  "dist/capabilities/quality-gate-runner/composition/select-package-script-executor.d.ts.map",
  "dist/capabilities/quality-gate-runner/composition/select-package-script-executor.js",
  "dist/capabilities/quality-gate-runner/composition/select-package-script-executor.js.map",
  "dist/capabilities/repository-agent-workflow/adapters/outbound/bun/bun-package-script-runner.d.ts",
  "dist/capabilities/repository-agent-workflow/adapters/outbound/bun/bun-package-script-runner.d.ts.map",
  "dist/capabilities/repository-agent-workflow/adapters/outbound/bun/bun-package-script-runner.js",
  "dist/capabilities/repository-agent-workflow/adapters/outbound/bun/bun-package-script-runner.js.map",
  "dist/capabilities/repository-agent-workflow/composition/select-package-script-runner.d.ts",
  "dist/capabilities/repository-agent-workflow/composition/select-package-script-runner.d.ts.map",
  "dist/capabilities/repository-agent-workflow/composition/select-package-script-runner.js",
  "dist/capabilities/repository-agent-workflow/composition/select-package-script-runner.js.map",
  "dist/process-execution/application/runtime-selection.d.ts",
  "dist/process-execution/application/runtime-selection.d.ts.map",
  "dist/process-execution/application/runtime-selection.js",
  "dist/process-execution/application/runtime-selection.js.map",
  "dist/process-execution/node-runtime-verifier.d.ts",
  "dist/process-execution/node-runtime-verifier.d.ts.map",
  "dist/process-execution/node-runtime-verifier.js",
  "dist/process-execution/node-runtime-verifier.js.map",
  "dist/capabilities/quality-gate-runner/adapters/outbound/package-script-process.d.ts",
  "dist/capabilities/quality-gate-runner/adapters/outbound/package-script-process.d.ts.map",
  "dist/capabilities/quality-gate-runner/adapters/outbound/package-script-process.js",
  "dist/capabilities/quality-gate-runner/adapters/outbound/package-script-process.js.map",
  "dist/process-execution/windows-command-launch.d.ts",
  "dist/process-execution/windows-command-launch.d.ts.map",
  "dist/process-execution/windows-command-launch.js",
  "dist/process-execution/windows-command-launch.js.map",
]);

function archiveWithEntries(count) {
  return tarArchive(
    Array.from({ length: count }, (_, index) => ({ name: `package/dist/${index}.js` })),
  );
}

test("keeps the Foundation archive exception package-specific and bounded", () => {
  assert.equal(inspectCompressedTarArchive(archiveWithEntries(2_500)).entryCount, 2_500);
  assert.throws(
    () => inspectCompressedTarArchive(archiveWithEntries(2_501)),
    /too many entries: 2501/u,
  );
  const atFoundationLimit = archiveWithEntries(2_871);
  assert.throws(() => inspectCompressedTarArchive(atFoundationLimit), /too many entries/u);
  assert.equal(
    inspectCompressedTarArchive(atFoundationLimit, FOUNDATION_PACKAGE).entryCount,
    2_871,
  );
  assert.throws(
    () => inspectCompressedTarArchive(archiveWithEntries(2_872), FOUNDATION_PACKAGE),
    /too many entries: 2872/u,
  );
});

test("applies the same Foundation budget to archive listings", () => {
  const unrelatedListing = [
    "package/package.json",
    "package/LICENSE",
    "package/README.md",
    ...Array.from({ length: 2_497 }, (_, index) => `package/dist/${index}.js`),
  ];
  const unrelatedInput = {
    archiveBytes: Buffer.from("fixture"),
    packageName: "@fixture/unrelated",
    requiredArtifactPaths: ["dist/0.js"],
    verboseListing: "",
  };
  assert.doesNotThrow(() =>
    assertArchiveSafety({
      ...unrelatedInput,
      listing: unrelatedListing.join("\n"),
    }),
  );
  assert.throws(
    () =>
      assertArchiveSafety({
        ...unrelatedInput,
        listing: [...unrelatedListing, "package/dist/over-limit.js"].join("\n"),
      }),
    /too many entries: 2501/u,
  );

  const listing = [
    "package/package.json",
    "package/LICENSE",
    "package/README.md",
    ...Array.from({ length: 2_868 }, (_, index) => `package/dist/${index}.js`),
  ];
  const input = {
    archiveBytes: Buffer.from("fixture"),
    packageName: FOUNDATION_PACKAGE,
    requiredArtifactPaths: ["dist/0.js"],
    verboseListing: "",
  };
  assert.doesNotThrow(() => assertArchiveSafety({ ...input, listing: listing.join("\n") }));
  assert.throws(
    () =>
      assertArchiveSafety({
        ...input,
        listing: [
          ...listing,
          ...Array.from({ length: 1 }, (_, index) => `package/dist/extra-${index}.js`),
        ].join("\n"),
      }),
    /too many entries: 2872/u,
  );
});

test("admits the complete built Foundation package inventory and rejects one additional member", async () => {
  await preparePackages();
  const root = "packages/engineering-foundation";
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const paths = new Set(["package.json", "LICENSE", "README.md"]);
  async function visit(path) {
    const metadata = await lstat(join(root, path));
    assert.equal(metadata.isSymbolicLink(), false, path);
    if (metadata.isDirectory()) {
      for (const entry of await readdir(join(root, path))) {
        await visit(`${path}/${entry}`);
      }
    } else {
      assert.ok(metadata.isFile(), path);
      paths.add(path);
    }
  }
  for (const path of manifest.files) {
    await visit(path);
  }
  assert.equal(
    paths.size,
    2_871,
    "Requalify the complete package inventory when its membership changes",
  );
  assert.equal(
    createHash("sha256")
      .update([...paths].toSorted().join("\n") + "\n")
      .digest("hex"),
    "32c55269a6fea2465deb38c758bed25470ec5473b2c7f88e405124607ce95267",
    "Requalify exact artifact membership, even when the count stays unchanged",
  );
  assert.equal(
    [...paths].some((path) => path.startsWith("presets/")),
    false,
  );
  assert.ok(paths.has("schemas/quality-source-coverage/v4.schema.json"));
  assert.ok(paths.has("schemas/quality-source-coverage/v3.schema.json"));
  assert.ok(paths.has("schemas/package-public-api-native-transition/v1.schema.json"));
  for (const path of [...EXPECTED_NEW_MODULE_ARTIFACTS, ...EXPECTED_F3_ARTIFACTS]) {
    assert.ok(
      paths.has(path),
      `Expected compiled module artifact is missing from actual inventory: ${path}`,
    );
  }
  const listing = [...paths].toSorted().map((path) => `package/${path}`);
  const input = {
    archiveBytes: Buffer.from("inventory"),
    packageName: FOUNDATION_PACKAGE,
    requiredArtifactPaths: [...paths],
    allowedArtifactPaths: manifest.files,
    verboseListing: "",
  };
  assert.doesNotThrow(() => assertArchiveSafety({ ...input, listing: listing.join("\n") }));
  assert.throws(
    () =>
      assertArchiveSafety({
        ...input,
        listing: [...listing, "package/dist/over-limit.js"].join("\n"),
      }),
    /too many entries: 2872/u,
  );
});

test("rejects complete payload blocks without an observed two-zero-block terminator", () => {
  const complete = tarArchive([{ name: "package/package.json", data: Buffer.from("{}") }]);
  const tar = gunzipSync(complete);
  assert.equal(inspectCompressedTarArchive(complete).entryCount, 1);
  for (const missing of [512, 1024]) {
    assert.throws(
      () => inspectCompressedTarArchive(gzipSync(tar.subarray(0, tar.length - missing))),
      /terminator/u,
    );
  }
  assert.throws(() => inspectCompressedTarArchive(gzipSync(Buffer.alloc(0))), /terminator/u);
});

test("F3 archive growth is exactly 22 complete production compiler tuples", () => {
  assert.equal(F3_PRODUCTION_MODULES.baselineEntries, 2783);
  assert.equal(F3_PRODUCTION_MODULES.entries, 2871);
  assert.equal(F3_PRODUCTION_MODULES.removedEntries, 0);
  assert.equal(F3_PRODUCTION_MODULES.productionModuleStems.length, 22);
  assert.equal(EXPECTED_F3_ARTIFACTS.length, 88);
  assert.equal(new Set(EXPECTED_F3_ARTIFACTS).size, 88);
  assert.equal(
    F3_PRODUCTION_MODULES.baselineEntries + EXPECTED_F3_ARTIFACTS.length,
    F3_PRODUCTION_MODULES.entries,
  );
  for (const path of EXPECTED_F3_ARTIFACTS) {
    assert.match(path, /^dist\//u);
    assert.doesNotMatch(path, /(?:^|\/)(?:tests|node_modules|\.cache)(?:\/|$)/u);
  }
});
