import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readQualifiedReleaseArtifact } from "../scripts/release-publish-ordered-runtime.mjs";
import { packAndInspectArtifact, snapshotVerifiedArtifact } from "../scripts/pack-artifact-e2e.mjs";
import { createPackFixture, qualifiedArchive } from "./pack-publishable-artifacts-support.mjs";
import { manifestFixtureRecord } from "./pack-manifest-authority-cases.ts";

async function assertSealedDependencyAuthority(t: TestContext): Promise<void> {
  const fixture = await createPackFixture(t, "pack-dependency-substitution-");
  const authoritativeManifest = {
    name: "@fixture/qualified",
    peerDependencies: { external: "1.0.0" },
    version: "1.2.3",
  };
  await writeFile(join(fixture.packageRoot, "package.json"), JSON.stringify(authoritativeManifest));
  const substituted = qualifiedArchive({
    ...authoritativeManifest,
    peerDependencies: { external: "9.0.0" },
  });
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
      runPnpm: async (
        args: readonly string[],
        _cwd: string,
        options: { environment: Record<string, string> },
      ) => {
        assert.equal(args[0], "pack");
        assert.equal(options.environment.pnpm_config_ignore_pnpmfile, "false");
        const destination = args.at(args.indexOf("--pack-destination") + 1);
        assert.ok(typeof destination === "string" && destination.length > 0);
        const hookPath = join(destination, "..", "canonical-packing-hook.cjs");
        assert.ok(args.includes(`--config.pnpmfile=${hookPath}`));
        assert.deepEqual(
          await readFile(hookPath),
          await readFile(new URL("../.pnpmfile.cjs", import.meta.url)),
        );
        assert.equal(options.environment.pnpm_config_ignore_scripts, "true");
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "fixture-qualified-1.2.3.tgz"), substituted);
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
    /dependency manifest differs from the sealed publish authority/u,
  );
}

async function assertWildcardArtifact(t: TestContext, scenario: string): Promise<void> {
  const fixture = await createPackFixture(t, "pack-wildcard-integration-");
  const manifest = {
    name: "@fixture/qualified",
    version: "1.2.3",
    exports: { "./schemas/*": "./schemas/*" },
    files: scenario === "files-omits-export" ? ["dist"] : ["dist", "schemas"],
  };
  const schema = Buffer.from('{"$id":"https://fixture.test/v1","type":"string"}\n');
  const secondSchema = Buffer.from('{"$id":"https://fixture.test/v2","type":"string"}\n');
  await writeFile(join(fixture.packageRoot, "package.json"), JSON.stringify(manifest));
  await mkdir(join(fixture.packageRoot, "schemas"));
  await writeFile(join(fixture.packageRoot, "schemas/v1.schema.json"), schema);
  await writeFile(join(fixture.packageRoot, "schemas/v2.schema.json"), secondSchema);
  const packOutputs: string[] = [];
  const input = {
    ...fixture,
    packageName: manifest.name,
    buildPackageNames: [manifest.name],
    dependencyDeclarations: { [manifest.name]: [] },
    allowedArtifactPaths: ["dist", "schemas"],
    requiredArtifactPaths: ["dist/index.js"],
    stagePackages: [
      { name: manifest.name, root: "packages/qualified", sourceRoot: fixture.packageRoot },
    ],
    runBuild: async (root: string) => {
      await mkdir(join(root, "dist"));
      await writeFile(join(root, "dist/index.js"), "export {};\n");
    },
    runPnpm: async (args: readonly string[], root: string) => {
      const entries =
        scenario === "files-omits-export"
          ? []
          : [
              { name: "package/schemas/v1.schema.json", data: schema },
              ...(scenario === "archive-member-removed"
                ? []
                : [
                    {
                      name: "package/schemas/v2.schema.json",
                      data:
                        scenario === "schema-bytes-changed"
                          ? Buffer.from('{"type":"number"}\n')
                          : secondSchema,
                    },
                  ]),
            ];
      const bytes = qualifiedArchive(
        JSON.parse(await readFile(join(root, "package.json"), "utf8")),
        entries,
      );
      const destination = args.at(args.indexOf("--pack-destination") + 1);
      assert.ok(typeof destination === "string" && destination.length > 0);
      const archivePath = join(destination, "fixture-qualified-1.2.3.tgz");
      packOutputs.push(archivePath);
      await writeFile(archivePath, bytes);
    },
  };
  if (scenario !== "complete") {
    await assert.rejects(
      packAndInspectArtifact(input),
      scenario === "schema-bytes-changed"
        ? /content differs.*schemas\/v2.schema.json/u
        : /missing wildcard export member/u,
    );
    return;
  }
  const artifact: unknown = await packAndInspectArtifact(input);
  const record = {
    ...manifestFixtureRecord(artifact),
    packageName: manifest.name,
    packageVersion: manifest.version,
  };
  const info = { name: manifest.name, version: manifest.version };
  const released = manifestFixtureRecord(await readQualifiedReleaseArtifact(record, info));
  assert.equal(
    released["integrity"],
    `sha512-${createHash("sha512").update(snapshotVerifiedArtifact(artifact)).digest("base64")}`,
  );
  assert.deepEqual(manifestFixtureRecord(released["manifest"])["exports"], manifest.exports);
  await Promise.all(packOutputs.map((path) => writeFile(path, "changed pack output")));
  assert.deepEqual(await readQualifiedReleaseArtifact(record, info), released);
  await assert.rejects(
    readQualifiedReleaseArtifact(record, { ...info, version: "1.2.4" }),
    /identity differs/u,
  );
  await assert.rejects(readQualifiedReleaseArtifact(undefined, info), /identity differs/u);
  await assert.rejects(
    readQualifiedReleaseArtifact(
      { ...record, packageVersion: "1.2.4" },
      { ...info, version: "1.2.4" },
    ),
    /manifest identity differs/u,
  );
  const archivePath = manifestFixtureRecord(record)["archivePath"];
  assert.ok(typeof archivePath === "string");
  await rm(archivePath);
  const firstPackOutput = packOutputs.at(0);
  assert.ok(typeof firstPackOutput === "string" && firstPackOutput.length > 0);
  await symlink(firstPackOutput, archivePath);
  await assert.rejects(readQualifiedReleaseArtifact(record, info), /replaced by a symlink/u);
  await rm(archivePath);
  await writeFile(archivePath, "replaced verified archive");
  await assert.rejects(readQualifiedReleaseArtifact(record, info), /digest|SHA-256|changed/iu);
}

export function registerManifestQualificationTests(): void {
  void test(
    "packed dependency versions must match the sealed publish authority",
    assertSealedDependencyAuthority,
  );
  for (const scenario of [
    "complete",
    "archive-member-removed",
    "files-omits-export",
    "schema-bytes-changed",
  ]) {
    void test(`production pack wildcard inventory: ${scenario}`, (t) =>
      assertWildcardArtifact(t, scenario));
  }
}
