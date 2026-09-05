import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { checkProductionQuality, runProductionTypedLint } from "../scripts/check-production-quality.mjs";
import { PUBLISHABLE_PACKAGES } from "../scripts/publishable-packages.mjs";

const repositoryPath = resolve(import.meta.dirname, "..");
const ruleNames = ["clock", "environment", "randomness", "timers"];
const readJson = async (path) => JSON.parse(await readFile(join(repositoryPath, path), "utf8"));
async function fixture(t) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "ef-production-quality-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const write = async (path, value) => {
    await mkdir(dirname(join(repositoryRoot, path)), { recursive: true });
    await writeFile(join(repositoryRoot, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const paths = ["package.json", ".oxlintrc.type-aware.json", "architecture/foundation/feature-modules.json", "architecture/foundation/suppression-governance.yaml", "sgconfig.yml"];
  for (const path of paths) {await write(path, await readFile(join(repositoryPath, path), "utf8"));}
  const typed = await readJson(".oxlintrc.type-aware.json");
  typed.extends = typed.extends.map((path) => resolve(repositoryPath, path));
  await write(".oxlintrc.type-aware.json", typed);
  for (const item of PUBLISHABLE_PACKAGES) {
    await write(`${item.root}/package.json`, { name: item.name, version: "1.0.0" });
    await write(`${item.root}/src/index.ts`, "export const value = 1;\n");
  }
  for (const name of ruleNames) {
    const path = `architecture/ast-grep/rules/no-ambient-${name}.yml`;
    const bytes = await readFile(join(repositoryPath, path), "utf8");
    await write(path, bytes);
    for (const ignored of YAML.parse(bytes).ignores ?? []) {await write(ignored, "export const observed = 1;\n");}
  }
  const check = () => checkProductionQuality({ repositoryRoot });
  return { repositoryRoot, write, check };
}
test("covers all six packages from the existing inventory", async (t) => {
  const f = await fixture(t);
  const result = await f.check();
  assert.deepEqual(result.problems, []);
  assert.equal(result.packages, PUBLISHABLE_PACKAGES.length);
});
for (const [label, mutate, code] of [
  ["seventh uncatalogued production package", (f) => f.write("packages/new/package.json", { name: "@fixture/new", version: "1.0.0" }), "package-inventory"],
  ["uncatalogued private production package", (f) => f.write("packages/private/package.json", { name: "@fixture/private", private: true }), "package-inventory"],
  ["single-package typed command", async (f) => {
    const pkg = await readJson("package.json");
    pkg.scripts["lint:typed"] = "oxlint packages/engineering-foundation/src";
    await f.write("package.json", pkg);
  }, "typed-command"],
  ["typed source exclusion", async (f) => {
    const config = await readJson(".oxlintrc.type-aware.json");
    config.extends = config.extends.map((path) => resolve(repositoryPath, path));
    config.ignorePatterns.push("packages/docs-protocol/src/**");
    await f.write(".oxlintrc.type-aware.json", config);
  }, "typed-coverage"],
  ["missing suppression coverage", (f) => f.write("architecture/foundation/suppression-governance.yaml", "schemaVersion: 1\ngovernedRoots: [packages/engineering-foundation/src]\n"), "suppression-coverage"],
  ["single-package ambient scope", async (f) => {
    const path = "architecture/ast-grep/rules/no-ambient-clock.yml";
    const rule = YAML.parse(await readFile(join(repositoryPath, path), "utf8"));
    rule.files = ["packages/engineering-foundation/src/**/*.ts"];
    await f.write(path, YAML.stringify(rule));
  }, "ambient-coverage"],
  ["broad infrastructure exception", async (f) => {
    const path = "architecture/ast-grep/rules/no-ambient-clock.yml";
    const rule = YAML.parse(await readFile(join(repositoryPath, path), "utf8"));
    rule.ignores = ["packages/*/src/**/adapters/**"];
    await f.write(path, YAML.stringify(rule));
  }, "ambient-exception"]
]) {test(`rejects ${label}`, async (t) => {
  const f = await fixture(t);
  await mutate(f);
  const result = await f.check();
  assert.ok(result.problems.some((problem) => problem.code === code), JSON.stringify(result));
});}

test("original typed command misses a real unsafe fixture outside Foundation; expanded scope finds it", async (t) => {
  const f = await fixture(t);
  await symlink(join(repositoryPath, "node_modules"), join(f.repositoryRoot, "node_modules"), "junction");
  const bin = (await readJson("node_modules/oxlint/package.json")).bin.oxlint;
  await f.write("tsconfig.json", { compilerOptions: { strict: true, target: "ESNext", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["packages/**/*.ts"] });
  await f.write("packages/docs-protocol/src/index.ts", "declare const unsafe: any;\nexport const result: number = unsafe;\n");
  const config = await readJson(".oxlintrc.type-aware.json");
  config.extends = config.extends.map((path) => resolve(repositoryPath, path));
  await f.write("typed.json", config);
  const run = (roots) => spawnSync(process.execPath, [join(repositoryPath, "node_modules/oxlint", bin), "--config", "typed.json", "--deny-warnings", "--disable-nested-config", ...roots], { cwd: f.repositoryRoot, encoding: "utf8" });
  // Exact source scope read from originalBase 588a50d package.json, not checkpoint.
  const baseline = run(["packages/engineering-foundation/src"]);
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  const current = run(PUBLISHABLE_PACKAGES.map(({ root }) => `${root}/src`));
  assert.equal(current.status, 1, current.stdout + current.stderr);
  assert.match(current.stdout + current.stderr, /no-unsafe-assignment/u);
});

test("actual ast-grep scan rejects all ambient operations in every production package", async (t) => {
  const f = await fixture(t);
  for (const { root } of PUBLISHABLE_PACKAGES) {await f.write(`${root}/src/index.ts`, "export const now = Date.now();\nexport const value = Math.random();\nexport const env = process.env.TEST;\nsetTimeout(() => {}, 1);\n");}
  const run = () => spawnSync(process.execPath, [join(repositoryPath, "scripts/run-ast-grep.mjs"), "scan", "--config", "sgconfig.yml", "--json=compact"], { cwd: f.repositoryRoot, encoding: "utf8" });
  // The original rules named only Foundation; demonstrate the real missing scope.
  for (const name of ruleNames) {
    const path = `architecture/ast-grep/rules/no-ambient-${name}.yml`;
    const rule = YAML.parse(await readFile(join(repositoryPath, path), "utf8"));
    await f.write(path, YAML.stringify({ ...rule, files: ["packages/engineering-foundation/src/**/*.ts"] }));
  }
  const baseline = run();
  assert.equal(baseline.status, 1, baseline.stderr);
  const oldPaths = new Set(JSON.parse(baseline.stdout).map((entry) => entry.file));
  assert.deepEqual([...oldPaths], ["packages/engineering-foundation/src/index.ts"]);
  for (const name of ruleNames) {
    const path = `architecture/ast-grep/rules/no-ambient-${name}.yml`;
    await f.write(path, await readFile(join(repositoryPath, path), "utf8"));
  }
  const current = run();
  assert.equal(current.status, 1, current.stderr);
  const diagnostics = JSON.parse(current.stdout);
  for (const { root } of PUBLISHABLE_PACKAGES) {
    assert.equal(diagnostics.filter((entry) => entry.file === `${root}/src/index.ts`).length, 4);
  }
});

for (const extension of ["mts", "cts", "mjs", "cjs", "d.mts", "d.cts"]) {
  test(`quality scope discovers .${extension} and requires explicit language adoption`, async (t) => {
    const f = await fixture(t); await f.write(`packages/docs-protocol/src/added.${extension}`, "export const value = 1;");
    assert.ok((await f.check()).problems.some(({ code, message }) => code === "source-language" && message.includes(`added.${extension}`)));
  });
}
for (const entry of ["check", "check:fast", "quality:scope:check"]) {
  test(`quality scope rejects successful bypass in ${entry}`, async (t) => {
    const f = await fixture(t), pkg = await readJson("package.json");
    pkg.scripts[entry] = entry === "quality:scope:check" ? "echo scripts/check-production-quality.mjs" : "true || pnpm quality:scope:check";
    await f.write("package.json", pkg);
    assert.ok((await f.check()).problems.some(({ code }) => code === "scope-command"));
  });
}

test("actual production invocation analyzes unsafe source despite eslintignore and nested ignores", async (t) => {
  const f = await fixture(t);
  await symlink(join(repositoryPath, "node_modules"), join(f.repositoryRoot, "node_modules"), "junction");
  await f.write("tsconfig.json", { compilerOptions: { strict: true, target: "ESNext", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["packages/**/*.ts"] });
  const path = "packages/docs-protocol/src/unsafe.ts";
  await f.write(path, "declare const unsafe: any; export const value: number = unsafe;");
  const run = () => runProductionTypedLint({ repositoryRoot: f.repositoryRoot });
  const control = await run();
  assert.equal(control.status, 1, control.stdout + control.stderr);
  assert.match(control.stdout + control.stderr, /no-unsafe-assignment/u);
  await f.write(".eslintignore", `${path}\n`);
  await f.write("packages/docs-protocol/src/.eslintignore", "*.ts\n");
  await f.write("packages/docs-protocol/.oxlintrc.json", { ignorePatterns: ["**/*.ts"] });
  assert.deepEqual((await f.check()).problems, []);
  const ignored = await run();
  assert.equal(ignored.status, 1, ignored.stdout + ignored.stderr);
  assert.match(ignored.stdout + ignored.stderr, /no-unsafe-assignment/u);
  await f.write(path, "export const value: number = 1;");
  const safe = await run();
  assert.equal(safe.status, 0, safe.stdout + safe.stderr);
});
test("inherited ignores follow actual Oxlint semantics and cannot silently omit unsafe source", async (t) => {
  const f = await fixture(t);
  await symlink(join(repositoryPath, "node_modules"), join(f.repositoryRoot, "node_modules"), "junction");
  await f.write("tsconfig.json", { compilerOptions: { strict: true, target: "ESNext", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["packages/**/*.ts"] });
  await f.write("packages/docs-protocol/src/index.ts", "declare const unsafe: any; export const value: number = unsafe;");
  const config = JSON.parse(await readFile(join(f.repositoryRoot, ".oxlintrc.type-aware.json"), "utf8"));
  await f.write("inherited.json", { ignorePatterns: ["packages/docs-protocol/src/**"] });
  config.extends.push("./inherited.json");
  await f.write(".oxlintrc.type-aware.json", config);
  // This pinned Oxlint does not inherit ignorePatterns. Qualify that behavior
  // with actual diagnostics instead of treating our own glob guess as evidence.
  assert.deepEqual((await f.check()).problems, []);
  const actual = await runProductionTypedLint({ repositoryRoot: f.repositoryRoot });
  assert.equal(actual.status, 1, actual.stdout + actual.stderr);
  assert.match(actual.stdout + actual.stderr, /no-unsafe-assignment/u);
});
for (const script of ["lint:typed", "architecture:patterns"]) {
  for (const mode of ["disconnect", "echo", "short-circuit", "mask", "wrong-arguments", "missing"]) {
    test(`full quality gate rejects ${script}: ${mode}`, async (t) => {
      const f = await fixture(t), pkg = await readJson("package.json"), terminal = pkg.scripts[script];
      if (mode === "disconnect") {
        if (script === "lint:typed") {pkg.scripts.lint = "pnpm lint:fast";}
        else {pkg.scripts.check = pkg.scripts.check.replace(" && pnpm architecture:patterns ", " ");}
      } else if (mode === "missing") {delete pkg.scripts[script];}
      else {pkg.scripts[script] = ({ echo: `echo ${terminal}`, "short-circuit": `true || ${terminal}`, mask: `${terminal} || true`, "wrong-arguments": `${terminal} --help` })[mode];}
      await f.write("package.json", pkg);
      assert.ok((await f.check()).problems.some(({ code }) => code === "quality-command"));
    });
  }
  test(`full quality gate retains fail-closed prerequisite for ${script}; fast needs no typed run`, async (t) => {
    const f = await fixture(t), pkg = await readJson("package.json");
    pkg.scripts[script] = `false && ${pkg.scripts[script]}`;
    await f.write("package.json", pkg);
    assert.deepEqual((await f.check()).problems, []);
  });
}
