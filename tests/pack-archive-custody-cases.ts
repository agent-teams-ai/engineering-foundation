import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  packAndInspectArtifact,
  readVerifiedArchive,
  snapshotVerifiedArtifact,
} from "../scripts/pack-artifact-e2e.mjs";
import { assertSecretCanaryAbsent } from "../scripts/pack-test-support.mjs";
import { registerPackedDocsAdapterHistoryTests } from "./pack-docs-adapter-history-cases.mjs";
import { registerCleanBuildStageTests } from "./pack-clean-build-stage-cases.mjs";
import {
  createPackFixture,
  qualifiedArchive,
  tarArchive,
} from "./pack-publishable-artifacts-support.mjs";

export function registerArchiveCustodyTests(): void {
  void test("same-identity manifest substitution and injected payloads fail closed", async (t) => {
    const fixture = await createPackFixture(t, "pack-substituted-manifest-");
    await writeFile(
      join(fixture.packageRoot, "package.json"),
      JSON.stringify({
        exports: { ".": "./dist/index.js" },
        files: ["dist"],
        name: "@fixture/qualified",
        scripts: { build: "fixture-build" },
        version: "1.2.3",
      }),
    );
    const forgedManifest = {
      exports: { ".": "./dist/attacker.js" },
      files: ["dist"],
      name: "@fixture/qualified",
      scripts: { build: "fixture-build", postinstall: "node attacker.js" },
      version: "1.2.3",
    };
    const forgedBytes = qualifiedArchive(forgedManifest);
    const injectedBytes = qualifiedArchive(
      JSON.parse(await readFile(join(fixture.packageRoot, "package.json"), "utf8")),
      [{ data: Buffer.from("attack\n"), name: "package/dist/attacker.js" }],
    );
    const substitutedContentBytes = tarArchive([
      {
        data: await readFile(join(fixture.packageRoot, "package.json")),
        name: "package/package.json",
      },
      { data: Buffer.from("fixture license\n"), name: "package/LICENSE" },
      { data: Buffer.from("# Fixture\n"), name: "package/README.md" },
      { data: Buffer.from("attack();\n"), name: "package/dist/index.js" },
    ]);
    const substitutions: readonly (readonly [Buffer, RegExp])[] = [
      [forgedBytes, /manifest identity does not match/u],
      [injectedBytes, /payload differs/u],
      [substitutedContentBytes, /content differs/u],
    ];
    for (const [bytes, expected] of substitutions) {
      await assert.rejects(
        packAndInspectArtifact({
          ...fixture,
          buildPackageNames: ["@fixture/qualified"],
          dependencyDeclarations: { "@fixture/qualified": [] },
          packageName: "@fixture/qualified",
          requiredArtifactPaths: ["dist/index.js"],
          runBuild: async (packageRoot: string) => {
            await mkdir(join(packageRoot, "dist"), { recursive: true });
            await writeFile(join(packageRoot, "dist", "index.js"), "export {};\n");
          },
          runPnpm: async (args: readonly string[]) => {
            const destination = args.at(args.indexOf("--pack-destination") + 1);
            assert.ok(typeof destination === "string" && destination.length > 0);
            await mkdir(destination, { recursive: true });
            await writeFile(join(destination, "fixture-qualified-1.2.3.tgz"), bytes);
          },
          stagePackages: [
            {
              name: "@fixture/qualified",
              root: "packages/qualified",
              sourceRoot: fixture.packageRoot,
            },
          ],
        }),
        expected,
      );
    }
  });

  registerAdditionalArchiveCustodyTests();
}
function registerAdditionalArchiveCustodyTests(): void {
  void test("returned artifact is a verified byte snapshot, not a mutable pack output", async (t) => {
    const fixture = await createPackFixture(t, "pack-verified-snapshot-");
    const bytes = qualifiedArchive({ name: "@fixture/qualified", version: "1.2.3" });
    const packOutputs: string[] = [];
    const artifact = await packAndInspectArtifact({
      ...fixture,
      buildPackageNames: ["@fixture/qualified"],
      dependencyDeclarations: { "@fixture/qualified": [] },
      expectedManifest: { name: "@fixture/qualified", version: "1.2.3" },
      packageName: "@fixture/qualified",
      requiredArtifactPaths: ["dist/index.js"],
      runBuild: async () => {},
      runPnpm: async (args: readonly string[]) => {
        const destination = args.at(args.indexOf("--pack-destination") + 1);
        assert.ok(typeof destination === "string" && destination.length > 0);
        await mkdir(destination, { recursive: true });
        const path = join(destination, "fixture-qualified-1.2.3.tgz");
        packOutputs.push(path);
        await writeFile(path, bytes);
      },
      stagePackages: [
        {
          name: "@fixture/qualified",
          root: "packages/qualified",
          sourceRoot: fixture.packageRoot,
          version: "1.2.3",
        },
      ],
    });
    await Promise.all(packOutputs.map((path) => writeFile(path, "mutated")));
    assert.deepEqual(await readFile(artifact.archivePath), bytes);
    assert.equal(artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(snapshotVerifiedArtifact(artifact), bytes);
    await rm(artifact.archivePath);
    await symlink(packOutputs[0], artifact.archivePath);
    assert.deepEqual(snapshotVerifiedArtifact(artifact), bytes);
    await assert.rejects(
      readVerifiedArchive(artifact.archivePath, artifact.sha256),
      /replaced by a symlink/u,
    );
  });

  void test("required runtime asset deletion fails qualification after the package build contract", async (t) => {
    const fixture = await createPackFixture(t, "pack-required-assets-");
    await mkdir(join(fixture.packageRoot, "assets"));
    await writeFile(join(fixture.packageRoot, "assets", "catalog.json"), "{}\n");
    const bytesWithoutAsset = qualifiedArchive({ name: "@fixture/qualified", version: "1.2.3" });
    let builds = 0;
    await assert.rejects(
      packAndInspectArtifact({
        ...fixture,
        allowedArtifactPaths: ["dist", "assets"],
        buildPackageNames: ["@fixture/qualified"],
        dependencyDeclarations: { "@fixture/qualified": [] },
        expectedManifest: { name: "@fixture/qualified", version: "1.2.3" },
        packageName: "@fixture/qualified",
        requiredArtifactPaths: ["dist/index.js", "assets/catalog.json"],
        runBuild: async (packageRoot: string) => {
          builds += 1;
          // This seam stands in for the package-owned `pnpm run build` contract;
          // production invokes that script rather than raw tsc.
          await rm(join(packageRoot, "assets", "catalog.json"));
        },
        runPnpm: async (args: readonly string[]) => {
          const destination = args.at(args.indexOf("--pack-destination") + 1);
          assert.ok(typeof destination === "string" && destination.length > 0);
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, "fixture-qualified-1.2.3.tgz"), bytesWithoutAsset);
        },
        stagePackages: [
          {
            name: "@fixture/qualified",
            root: "packages/qualified",
            sourceRoot: fixture.packageRoot,
            version: "1.2.3",
          },
        ],
      }),
      /Required package entry missing: package\/assets\/catalog\.json/u,
    );
    assert.equal(builds, 2);
  });

  void test("two clean pack outputs must be byte-identical", async (t) => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "pack-determinism-"));
    t.after(() => rm(repositoryRoot, { force: true, recursive: true }));
    const packageRoot = join(repositoryRoot, "packages", "qualified");
    const temporaryRoot = join(repositoryRoot, "temporary");
    await mkdir(packageRoot, { recursive: true });
    await mkdir(temporaryRoot, { recursive: true });
    await writeFile(join(repositoryRoot, "LICENSE"), "fixture license\n");
    await writeFile(join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await writeFile(
      join(packageRoot, "package.json"),
      '{"name":"@fixture/qualified","version":"1.2.3"}\n',
    );
    await writeFile(join(packageRoot, "README.md"), "# Fixture\n");
    let invocation = 0;
    await assert.rejects(
      packAndInspectArtifact({
        artifactLabel: "qualified",
        buildPackageNames: ["@fixture/qualified"],
        dependencyDeclarations: { "@fixture/qualified": [] },
        expectedManifest: { name: "@fixture/qualified", version: "1.2.3" },
        packageName: "@fixture/qualified",
        packageRoot,
        repositoryRoot,
        requiredArtifactPaths: ["dist/index.js"],
        runBuild: async () => {},
        runPnpm: async (args: readonly string[]) => {
          const destination = args.at(args.indexOf("--pack-destination") + 1);
          assert.ok(typeof destination === "string" && destination.length > 0);
          await mkdir(destination, { recursive: true });
          invocation += 1;
          await writeFile(
            join(destination, "fixture-qualified-1.2.3.tgz"),
            `archive-${invocation}`,
          );
        },
        stagePackages: [
          {
            name: "@fixture/qualified",
            root: "packages/qualified",
            sourceRoot: packageRoot,
          },
        ],
        temporaryRoot,
      }),
      /byte-identical tarballs/u,
    );
    assert.equal(invocation, 2);
  });

  void test("secret canary scanning remains fail closed", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pack-secret-canary-"));
    t.after(() => rm(root, { force: true, recursive: true }));
    await writeFile(
      join(root, "artifact.js"),
      "AGENT_TEAMS_PACKAGE_SECRET_CANARY_DO_NOT_PUBLISH_7A13D6C4\n",
    );
    await assert.rejects(assertSecretCanaryAbsent(root), /Secret-like content leaked/u);
  });

  registerPackedDocsAdapterHistoryTests();
  registerCleanBuildStageTests();
}
