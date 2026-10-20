import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runRepositoryOxlint } from "../tools/repository-oxlint.ts";
import { copyPinnedToolchain } from "./features/quality-coverage/copied-toolchain.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const entry = resolve(repositoryRoot, "node_modules/oxlint/bin/oxlint");

test("pinned Oxlint retains source selection and real lint failures below an ignored projection parent", async (t) => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "foundation-profile-lint-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "--quiet", sourceRoot]).status, 0);
  await writeFile(join(sourceRoot, ".gitignore"), ".worker-tmp/\ngit-ignored.ts\n");
  await writeFile(join(sourceRoot, ".eslintignore"), "eslint-ignored.ts\n");
  await writeFile(join(sourceRoot, ".oxlintrc.json"), JSON.stringify({
    rules: { "no-debugger": "error", "no-console": "warn" },
    ignorePatterns: ["config-ignored.ts", "**/dist/**", "**/node_modules/**"]
  }));
  await writeFile(join(sourceRoot, ".oxlintrc.type-aware.json"), JSON.stringify({
    options: { typeAware: true }, plugins: ["typescript"],
    rules: { "typescript/no-floating-promises": "error" },
    ignorePatterns: ["config-ignored.ts", "**/dist/**", "**/node_modules/**"]
  }));
  await writeFile(join(sourceRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", types: [] },
    include: ["*.ts"]
  }));
  await writeFile(join(sourceRoot, "actual file.ts"), "export const value = 1;\n");
  await writeFile(join(sourceRoot, "-leading.ts"), "export const value = 2;\n");
  for (const name of ["git-ignored.ts", "eslint-ignored.ts", "config-ignored.ts"]) {
    await writeFile(join(sourceRoot, name), "debugger;\n");
  }
  for (const name of ["dist", "node_modules"]) {
    await mkdir(join(sourceRoot, name));
    await writeFile(join(sourceRoot, name, "ignored.ts"), "debugger;\n");
  }
  await copyPinnedToolchain(sourceRoot);
  const consumerRoot = join(sourceRoot, ".worker-tmp/projection");
  await mkdir(consumerRoot, { recursive: true });
  for (const name of [".gitignore", ".eslintignore", ".oxlintrc.json", ".oxlintrc.type-aware.json", "tsconfig.json",
    "actual file.ts", "-leading.ts", "git-ignored.ts", "eslint-ignored.ts", "config-ignored.ts", "dist", "node_modules"]) {
    await cp(join(sourceRoot, name), join(consumerRoot, name), { recursive: true });
  }
  const environment = { ...process.env, OXLINT_TSGOLINT_PATH: join(consumerRoot, "node_modules",
    "@oxlint-tsgolint", `${process.platform}-${process.arch}`, process.platform === "win32" ? "tsgolint.exe" : "tsgolint") };
  const input = { node: process.execPath, entry, sourceRoot, consumerRoot, environment,
    args: ["--config", ".oxlintrc.json", "--deny-warnings", "--disable-nested-config"] };
  const oldTraversal = spawnSync(process.execPath, [entry, ...input.args, "--debug", "files", "."], {
    cwd: consumerRoot, encoding: "utf8", env: environment
  });
  assert.equal(oldTraversal.status, 0, oldTraversal.stderr);
  assert.equal(oldTraversal.stdout, "", "the original cwd scan must reproduce the ignored-parent defect");
  assert.equal(await runRepositoryOxlint({ ...input, targets: ["."] }), 0);
  assert.equal(await runRepositoryOxlint({ ...input, targets: ["actual file.ts", "-leading.ts"] }), 0);
  for (const cwd of [sourceRoot, consumerRoot]) {
    await writeFile(join(cwd, "actual file.ts"), "debugger;\n");
  }
  assert.equal(await runRepositoryOxlint({ ...input, targets: ["."] }), 1);
  assert.equal(await runRepositoryOxlint({ ...input, targets: ["actual file.ts"] }), 1);
  for (const cwd of [sourceRoot, consumerRoot]) {
    await writeFile(join(cwd, "actual file.ts"), 'export {};\nPromise.resolve("unhandled");\n');
  }
  assert.equal(await runRepositoryOxlint({ ...input,
    args: ["--config", ".oxlintrc.type-aware.json", "--deny-warnings", "--disable-nested-config"],
    targets: ["actual file.ts"] }), 1);
  const typed = spawnSync(process.execPath, [entry, "--config", ".oxlintrc.type-aware.json",
    "--deny-warnings", "--disable-nested-config", "--", "actual file.ts"], {
    cwd: consumerRoot, encoding: "utf8", env: environment
  });
  assert.equal(typed.status, 1, `${typed.stdout}${typed.stderr}`);
  assert.match(typed.stdout, /no-floating-promises/u);
  assert.equal(typed.stderr, "");
  await assert.rejects(runRepositoryOxlint({ ...input, targets: ["config-ignored.ts"] }), /zero source files/u);
  await assert.rejects(runRepositoryOxlint({ ...input, targets: [] }), /explicit source targets/u);
});
