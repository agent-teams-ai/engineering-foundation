import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { checkChangesetCoverage } from "../scripts/check-changeset-coverage.mjs";

const execFileAsync = promisify(execFile);
const changesetsCli = createRequire(import.meta.url).resolve("@changesets/cli/bin.js");

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function createFixture() {
  // RUNNER_TEMP keeps the fixture on the checkout volume on Windows runners.
  const temporaryBase = process.env["RUNNER_TEMP"] ?? tmpdir();
  const root = await mkdtemp(join(temporaryBase, ".foundation-changeset-coverage-"));
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
    await git(packageFixture.root, "add", ".");
    await git(packageFixture.root, "commit", "-m", "change package without release intent");
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
    await git(packageFixture.root, "commit", "-m", "add release intent");
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
    await git(neutralFixture.root, "commit", "-m", "change repository-only files");
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

test("the installed release planner preserves an in-range peer minor and bumps an out-of-range peer", async () => {
  const configuration = JSON.parse(await readFile(new URL("../.changeset/config.json", import.meta.url), "utf8"));
  for (const [dependencyBump, dependencyVersion, dependentBump, dependentVersion] of [
    ["minor", "1.8.0", "minor", "0.1.0"],
    ["major", "2.0.0", "major", "1.0.0"],
  ]) {
    const { root } = await createFixture();
    try {
      for (const [localName, manifest] of [
        ["foundation", { name: "@fixture/foundation", version: "1.7.4" }],
        ["standard", { name: "@fixture/standard", version: "0.0.0",
          peerDependencies: { "@fixture/foundation": "workspace:^" },
          peerDependenciesMeta: { "@fixture/foundation": { optional: true } },
          devDependencies: { "@fixture/foundation": "workspace:*" } }],
      ]) {
        await mkdir(join(root, "packages", localName), { recursive: true });
        await writeFile(join(root, "packages", localName, "package.json"), JSON.stringify(manifest));
      }
      await writeFile(join(root, ".changeset", "config.json"), JSON.stringify({ ...configuration, changelog: false }));
      await writeFile(join(root, ".changeset", "peer-train.md"),
        `---\n"@fixture/foundation": ${dependencyBump}\n"@fixture/standard": minor\n---\n\nRelease the peer and its runner.\n`);
      const output = join(root, "release-plan.json");
      await execFileAsync(process.execPath, [changesetsCli, "status", "--output", output], {
        cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
      });
      const { releases } = JSON.parse(await readFile(output, "utf8"));
      assert.deepEqual(releases.map(({ name, type, newVersion }) => ({ name, type, newVersion })).toSorted((a, b) => a.name.localeCompare(b.name)), [
        { name: "@fixture/foundation", type: dependencyBump, newVersion: dependencyVersion },
        { name: "@fixture/standard", type: dependentBump, newVersion: dependentVersion },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
