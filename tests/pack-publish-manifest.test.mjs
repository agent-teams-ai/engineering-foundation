import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PUBLISHABLE_PACKAGES } from "../scripts/publishable-packages.mjs";
import { npmPackManifest } from "../scripts/pack-artifact-stage-support.mjs";
import { registerPeerReleaseTests, registerPeerInstallTests } from "./pack-peer-release-cases.ts";
import { registerManifestAuthorityTests } from "./pack-manifest-authority-cases.ts";
import { registerManifestQualificationTests } from "./pack-manifest-qualification-cases.ts";

registerPeerReleaseTests();
registerManifestAuthorityTests();
registerPeerInstallTests();

test("isolated publish manifest matches npm pack top-level key order", () => {
  const manifest = { version: "1.0.0", name: "@fixture/app", description: "fixture" };
  assert.deepEqual(Object.keys(npmPackManifest(manifest)), ["description", "name", "version"]);
  assert.deepEqual(Object.keys(manifest), ["version", "name", "description"]);
});

registerManifestQualificationTests();

test("release and registry targets invoke the concrete qualified pack gate", async () => {
  for (const path of ["release-publish-ordered-runtime.mjs", "registry-install-e2e.mjs"]) {
    const script = await readFile(new URL(`../scripts/${path}`, import.meta.url), "utf8");
    if (path === "release-publish-ordered-runtime.mjs") {
      assert.match(
        script,
        /const \{ packPublishableArtifacts \} = await import\("\.\/pack-publishable-artifacts\.mjs"\)/u,
      );
      assert.doesNotMatch(script, /import \{ packPublishableArtifacts \} from/u);
    } else {
      assert.match(
        script,
        /import\s*\{\s*runQualifiedArtifactConsumer,\s*withQualifiedPackageArtifacts,?\s*\}\s*from "\.\/pack-publishable-artifacts\.mjs"/u,
      );
      assert.match(
        script,
        /withQualifiedPackageArtifacts\("registry",\s*\(?handle\)?\s*=>\s*qualifyRegistryConsumers\(handle, group\),?\s*\)/u,
      );
      assert.match(script, /await runRegistryInstallTest\(\);/u);
      assert.match(script, /runQualifiedArtifactConsumer\(\s*handle,\s*"registry",/u);
    }
    if (path === "release-publish-ordered-runtime.mjs") {
      assert.match(
        script,
        /const qualified = await packPublishableArtifacts\(\{ temporaryRoot(?:: destination)? \}\)/u,
      );
      assert.match(script, /readQualifiedReleaseArtifact\(qualified\[/u);
      assert.match(script, /await readVerifiedArchive\(artifact\.archivePath, artifact\.sha256\)/u);
    } else {
      assert.match(script, /readQualifiedReleaseArtifact\(artifacts\[/u);
      assert.match(script, /await checkpoint\(\);\s+await publishArchive\(/u);
      assert.doesNotMatch(script, /packPublishableArtifacts\(/u);
    }
    assert.doesNotMatch(script, /stageBuiltMarkdownPublication|createTargetArchive\(/u);
  }
});

for (const scenario of [
  "valid-wave",
  "digest-mismatch",
  "advance-after-authorization",
  "notes-exact",
  "notes-prefix",
  "notes-level-three",
  "notes-empty",
  "prerequisite-secret",
  "ambiguous-absent",
  "lost-response",
]) {
  for (const eol of ["lf", "crlf"]) {
    test(`actual release runtime closes archive authorization: ${scenario} (${eol})`, () => {
      // Isolate module hooks, subprocess/fetch stubs, and accelerated retry timers.
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./support/release-runtime-probe.mjs", import.meta.url)),
          scenario,
          eol,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /credential-secret/u);
      const evidence = JSON.parse(result.stdout.trim().split("\n").at(-1));
      assert.equal(evidence.scenario, scenario);
      if (
        ["digest-mismatch", "advance-after-authorization", "prerequisite-secret"].includes(scenario)
      ) {
        assert.match(evidence.error, /publication did not start$/u);
        assert.equal(
          result.stderr.trim(),
          evidence.error
            .replace(/^Ordered release refused: /u, "")
            .replace(/; publication did not start$/u, ""),
        );
        assert.doesNotMatch(result.stdout, /New tag:/u);
      }
      if (["ambiguous-absent", "lost-response"].includes(scenario)) {
        assert.match(
          result.stderr,
          /initial publish failure: npm publish failed; code=ECONNRESET/u,
        );
        assert.equal(
          result.stderr.trim().split("\n").length,
          scenario === "lost-response" ? PUBLISHABLE_PACKAGES.length : 1,
        );
      }
    });
  }
}

test("repository packing hook restores scripts ordering after pnpm projection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "TEST-pack-manifest-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pnpm = fileURLToPath(new URL("../node_modules/pnpm/bin/pnpm.cjs", import.meta.url));
  const hook = fileURLToPath(new URL("../.pnpmfile.cjs", import.meta.url));
  const manifest = {
    name: "manifest-order-fixture",
    version: "1.0.0",
    scripts: { build: "true" },
    sideEffects: false,
  };
  await writeFile(join(root, "package.json"), JSON.stringify(npmPackManifest(manifest)));
  const marker = join(root, "ambient-hook-ran");
  const ambient = join(root, "ambient.cjs");
  await writeFile(
    ambient,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); module.exports = {};`,
  );
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    "configDependencies:\n  forbidden-plugin: invalid-without-integrity\n",
  );
  const outputs = [];
  for (const ignore of ["true", "false"]) {
    const result = spawnSync(
      process.execPath,
      [
        pnpm,
        "pack",
        "--pack-destination",
        root,
        "--config.ignore-scripts=true",
        `--config.pnpmfile=${hook}`,
        "--config.global-pnpmfile=",
        "--config.config-dependencies=",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          pnpm_config_ignore_pnpmfile: ignore,
          pnpm_config_global_pnpmfile: ambient,
        },
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const listing = spawnSync(
      "tar",
      ["-xOf", join(root, "manifest-order-fixture-1.0.0.tgz"), "package/package.json"],
      { encoding: "utf8" },
    );
    assert.equal(listing.status, 0, listing.stderr);
    outputs.push(JSON.parse(listing.stdout));
  }
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.deepEqual(outputs[0], outputs[1]);
  assert.notDeepEqual(Object.keys(outputs[0]), Object.keys(outputs[1]));
  assert.deepEqual(Object.keys(outputs[1]), Object.keys(npmPackManifest(manifest)));
});
