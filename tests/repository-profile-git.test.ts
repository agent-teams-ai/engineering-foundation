import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitRepositoryChangesReader } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/git/git-repository-changes-reader.js";
import { createWorkflowProcess } from "./support/capability-adapters.mjs";

test("stat-only Git refresh preserves source index bytes and exact staged/unstaged groups", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foundation-profile-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]): void => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "--quiet", "--initial-branch=main");
  await mkdir(join(root, "src"));
  for (const name of ["stat-only.ts", "staged.ts", "unstaged.ts"]) {
    await writeFile(join(root, "src", name), "export const value = 0;\n");
  }
  git("add", "--all");
  git("-c", "user.name=Foundation TEST", "-c", "user.email=test@agent-teams.invalid", "commit", "-qm", "test: initialize");
  await writeFile(join(root, "src/staged.ts"), "export const value = 1;\n");
  git("add", "--", "src/staged.ts");
  await writeFile(join(root, "src/unstaged.ts"), "export const value = 2;\n");
  const changedStat = new Date(Date.now() + 5_000);
  await utimes(join(root, "src/stat-only.ts"), changedStat, changedStat);
  const indexPath = join(root, ".git/index");
  const before = await readFile(indexPath);
  const report = await new GitRepositoryChangesReader(createWorkflowProcess()).collect({ consumerRoot: root, baseRef: "HEAD" });
  assert.deepEqual(report.changeGroups.staged.paths, ["src/staged.ts"]);
  assert.deepEqual(report.changeGroups.unstaged.paths, ["src/unstaged.ts"]);
  assert.deepEqual(report.changedPaths, ["src/staged.ts", "src/unstaged.ts"]);
  assert.deepEqual(await readFile(indexPath), before,
    "Git stat refresh must affect only its disposable index and must not hide racy edits");
});
