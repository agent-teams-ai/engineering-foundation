import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCleanBuildStage } from "../scripts/pack-artifact-e2e.mjs";
import { isPhysicallyContainedPath } from "./pack-publishable-artifacts-support.mjs";
export function registerInternalStageResolutionTest(): void {
  void test("clean stage resolves internal imports to freshly built staged copies", async (t) => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "pack-stage-resolution-"));
    t.after(() => rm(repositoryRoot, { force: true, recursive: true }));
    const temporaryRoot = join(repositoryRoot, "temporary");
    const sourceA = join(repositoryRoot, "packages", "a");
    const sourceB = join(repositoryRoot, "packages", "b");
    await mkdir(join(sourceA, "node_modules", "@fixture"), { recursive: true });
    await mkdir(join(sourceB, "dist"), { recursive: true });
    await mkdir(temporaryRoot, { recursive: true });
    await writeFile(join(repositoryRoot, "LICENSE"), "fixture license\n");
    await writeFile(join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await writeFile(join(sourceA, "package.json"), JSON.stringify({ name: "@fixture/a" }));
    await writeFile(
      join(sourceB, "package.json"),
      JSON.stringify({
        exports: "./dist/index.js",
        name: "@fixture/b",
        type: "commonjs",
      }),
    );
    await writeFile(join(sourceB, "dist", "index.js"), "module.exports = 'POISON SOURCE DIST';\n");
    await symlink(sourceB, join(sourceA, "node_modules", "@fixture", "b"), "dir");

    let resolvedInternalPath: string | undefined;
    const stage = await createCleanBuildStage(
      {
        artifactLabel: "fixture-a",
        buildPackageNames: ["@fixture/b", "@fixture/a"],
        dependencyDeclarations: {
          "@fixture/a": [{ name: "@fixture/b", section: "devDependencies" }],
          "@fixture/b": [],
        },
        packageName: "@fixture/a",
        packageRoot: sourceA,
        repositoryRoot,
        runBuild: async (packageRoot: string, { packageName }: { packageName: string }) => {
          if (packageName === "@fixture/b") {
            await mkdir(join(packageRoot, "dist"), { recursive: true });
            await writeFile(
              join(packageRoot, "dist", "index.js"),
              "module.exports = 'STAGED BUILD';\n",
            );
            return;
          }
          const requireFromStage = createRequire(join(packageRoot, "build-probe.cjs"));
          resolvedInternalPath = requireFromStage.resolve("@fixture/b");
          assert.equal(requireFromStage("@fixture/b"), "STAGED BUILD");
        },
        stagePackages: [
          { name: "@fixture/b", root: "packages/b", sourceRoot: sourceB },
          { name: "@fixture/a", root: "packages/a", sourceRoot: sourceA },
        ],
        temporaryRoot,
      },
      "a",
    );

    const stagedPackageRoot: unknown = stage.packageRoot;
    assert.ok(typeof stagedPackageRoot === "string");
    assert.ok(typeof resolvedInternalPath === "string" && resolvedInternalPath.length > 0);
    assert(await isPhysicallyContainedPath(stage.stageRoot, resolvedInternalPath));
    assert(!(await isPhysicallyContainedPath(sourceB, resolvedInternalPath)));
    assert.equal(
      await realpath(join(stagedPackageRoot, "node_modules", "@fixture", "b")),
      await realpath(join(stage.stageRoot, "packages", "b")),
    );
    await assert.rejects(
      realpath(join(stage.stageRoot, "node_modules", "@fixture", "b")),
      /ENOENT/u,
    );
    assert.equal(
      await readFile(join(sourceB, "dist", "index.js"), "utf8"),
      "module.exports = 'POISON SOURCE DIST';\n",
    );
  });
}
