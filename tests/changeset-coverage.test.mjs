import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { checkChangesetCoverage } from "../scripts/check-changeset-coverage.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "foundation-changeset-coverage-"));
  await mkdir(join(root, ".changeset"), { recursive: true });
  await mkdir(join(root, "packages", "fixture"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture-repository",
      private: true,
      packageManager: "pnpm@11.20.0",
    }),
  );
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(
    join(root, ".changeset", "config.json"),
    JSON.stringify({
      changelog: false,
      commit: false,
      fixed: [],
      linked: [],
      access: "restricted",
      baseBranch: "main",
      updateInternalDependencies: "patch",
      ignore: [],
    }),
  );
  await writeFile(
    join(root, "packages", "fixture", "package.json"),
    JSON.stringify({ name: "@fixture/package", version: "1.0.0" }),
  );
  await writeFile(join(root, "packages", "fixture", "index.js"), "export const value = 1;\n");
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Foundation Test");
  await git(root, "config", "user.email", "foundation-test@example.invalid");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return { root, baseRevision: await git(root, "rev-parse", "HEAD") };
}

test("package changes require a Changeset while repository-only changes remain neutral", async () => {
  const packageFixture = await createFixture();
  const neutralFixture = await createFixture();
  try {
    await writeFile(
      join(packageFixture.root, "packages", "fixture", "index.js"),
      "export const value = 2;\n",
    );
    await assert.rejects(
      checkChangesetCoverage({
        baseRevision: packageFixture.baseRevision,
        cwd: packageFixture.root,
      }),
      /Changeset coverage failed/u,
    );

    await writeFile(
      join(packageFixture.root, ".changeset", "required-release.md"),
      '---\n"@fixture/package": patch\n---\n\nPublish the changed package behavior.\n',
    );
    await git(packageFixture.root, "add", ".");
    await assert.doesNotReject(
      checkChangesetCoverage({
        baseRevision: packageFixture.baseRevision,
        cwd: packageFixture.root,
      }),
    );

    await mkdir(join(neutralFixture.root, "docs"), { recursive: true });
    await mkdir(join(neutralFixture.root, "tests"), { recursive: true });
    await writeFile(join(neutralFixture.root, "docs", "release.md"), "Internal release notes.\n");
    await writeFile(join(neutralFixture.root, "tests", "release.test.mjs"), "// repository-only test\n");
    await git(neutralFixture.root, "add", ".");
    await assert.doesNotReject(
      checkChangesetCoverage({
        baseRevision: neutralFixture.baseRevision,
        cwd: neutralFixture.root,
      }),
    );
  } finally {
    await Promise.all([
      rm(packageFixture.root, { recursive: true, force: true }),
      rm(neutralFixture.root, { recursive: true, force: true }),
    ]);
  }
});
