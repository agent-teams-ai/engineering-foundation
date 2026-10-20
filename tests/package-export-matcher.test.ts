import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import { resolvePackageExport } from "../packages/engineering-foundation/dist/workspace-inventory/api.js";
import type { PackageExportTarget } from "../packages/engineering-foundation/dist/workspace-inventory/application/model/workspace-inventory.js";
import { ruleIds, runSourceCapability, withCopiedFixture } from "./helpers/source-dependency-v2-fixture.mjs";

function match(target: PackageExportTarget, key = ".", subpath = key,
  condition: "import" | "require" = "import", typeOnly = false) {
  return resolvePackageExport([{ subpath: key, availability: "blocked", target }], subpath, condition, typeOnly);
}

async function sourceReport(target: PackageExportTarget, key: string, statement: string) {
  return withCopiedFixture("v2-valid", async (root: string) => {
    const manifestPath = join(root, "packages/core/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.exports = { [key]: target };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(root, "packages/app/src/index.ts"), `${statement}\n`);
    return runSourceCapability(root);
  });
}

async function nativeProbe(t: TestContext, target: PackageExportTarget, key = ".", subpath = key,
  files: Readonly<Record<string, string>> = { "dist/safe.cjs": 'module.exports = "SAFE_TARGET";\n' }) {
  const root = await mkdtemp(join(tmpdir(), "package-export-oracle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "node_modules", "export-oracle");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "export-oracle", exports: { [key]: target } }));
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(packageRoot, path)), { recursive: true });
    await writeFile(join(packageRoot, path), contents);
  }
  const specifier = `export-oracle${subpath === "." ? "" : subpath.slice(1)}`;
  return (["import", "require"] as const).map((condition) => {
    const code = condition === "import"
      ? `console.log((await import(${JSON.stringify(specifier)})).default);`
      : `console.log(require(${JSON.stringify(specifier)}));`;
    const result = spawnSync(process.execPath,
      [...(condition === "import" ? ["--input-type=module"] : []), "--eval", code],
      { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined);
    return { condition, ...result };
  });
}

void test("exact targets retain literal stars and pattern targets substitute every star", async (t) => {
  assert.deepEqual(match("./dist/literal*.cjs"), { available: true, targetPath: "./dist/literal*.cjs" });
  assert.deepEqual(match("./dist/*-*.cjs", "./*", "./feature"), {
    available: true, targetPath: "./dist/feature-feature.cjs",
  });
  for (const result of await nativeProbe(t, "./dist/*-*.cjs", "./*", "./feature", {
    "dist/feature-feature.cjs": 'module.exports = "SAFE_TARGET";\n',
  })) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "SAFE_TARGET", result.condition);
  }
  await t.test("POSIX native literal-star filename", { skip: process.platform === "win32" }, async (child) => {
    for (const result of await nativeProbe(child, "./dist/literal*.cjs", ".", ".", {
      "dist/literal*.cjs": 'module.exports = "LITERAL_STAR";\n',
    })) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "LITERAL_STAR", result.condition);
    }
  });
});

void test("invalid original package targets permit array fallback", async (t) => {
  for (const invalid of ["../outside.cjs", "./dist/../safe.cjs", "./dist/node_modules/hidden.cjs", "./dist/%6eode_modules/hidden.cjs"]) {
    const target = [invalid, "./dist/safe.cjs"];
    assert.deepEqual(match(target), { available: true, targetPath: "./dist/safe.cjs" }, invalid);
    for (const result of await nativeProbe(t, target)) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "SAFE_TARGET", `${invalid}: ${result.condition}`);
    }
  }
});

void test("a selected encoded separator or malformed pathname cannot fall back", async (t) => {
  for (const invalid of ["./dist/%2f*.cjs", "./dist/%5c*.cjs", "./dist/%FF*.cjs"]) {
    const target = [invalid, "./dist/safe.cjs"];
    assert.deepEqual(match(target, "./*", "./feature"), { available: false }, invalid);
    for (const result of await nativeProbe(t, target, "./*", "./feature")) {
      assert.notEqual(result.status, 0, result.condition);
      assert.match(result.stderr, /ERR_INVALID_MODULE_SPECIFIER|URI malformed/u);
      assert.equal(result.stdout, "");
    }
  }
});

void test("substitution cannot launder structural target segments into an array fallback", async (t) => {
  const target = ["./.*.", "./dist/safe.cjs"];
  assert.deepEqual(match(target, "./a*b", "./a/b"), { available: false });
  for (const result of await nativeProbe(t, target, "./a*b", "./a/b")) {
    assert.notEqual(result.status, 0, result.condition);
    assert.equal(result.stdout, "");
  }
  for (const capture of ["../hidden", "%2e%2e/hidden", "node_modules/hidden", "%6eode_modules/hidden"]) {
    assert.deepEqual(match(["./dist/*.cjs", "./dist/safe.cjs"], "./*", `./${capture}`), { available: false }, capture);
  }
});

void test("query and fragment annotations preserve Node import and require finalization", async (t) => {
  for (const suffix of ["?hint=%2f", "#%5c", "?hint=%FF#%2f", "?hint=%FF"]) {
    const target = `./dist/safe.cjs${suffix}`;
    for (const result of await nativeProbe(t, [target, "./dist/safe.cjs"])) {
      const available = result.condition === "import" || !/%2f|%5c/iu.test(suffix);
      assert.deepEqual(match([target, "./dist/safe.cjs"], ".", ".", result.condition), available
        ? { available: true, targetPath: "./dist/safe.cjs" }
        : { available: false });
      if (available) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), "SAFE_TARGET", result.condition);
      } else {
        assert.notEqual(result.status, 0, result.condition);
        assert.match(result.stderr, /ERR_INVALID_MODULE_SPECIFIER/u);
        assert.equal(result.stdout, "");
      }
    }
  }
});

void test("a selected missing file stays the selected structural target", async (t) => {
  const target = ["./dist/missing.cjs", "./dist/safe.cjs"];
  assert.deepEqual(match(target), { available: true, targetPath: "./dist/missing.cjs" });
  for (const result of await nativeProbe(t, target)) {
    assert.notEqual(result.status, 0, result.condition);
    assert.match(result.stderr, /MODULE_NOT_FOUND/u);
    assert.equal(result.stdout, "");
  }
});

void test("condition order, null and undefined continuation, types and exact-key priority remain authoritative", () => {
  assert.deepEqual(match({ default: "./dist/safe.cjs", node: null }), { available: true, targetPath: "./dist/safe.cjs" });
  assert.deepEqual(match({ node: null, default: "./dist/safe.cjs" }), { available: false });
  assert.deepEqual(match([null, { browser: "./dist/browser.cjs" }, "./dist/safe.cjs"]), { available: true, targetPath: "./dist/safe.cjs" });
  assert.deepEqual(match({ import: "../invalid.cjs", default: "./dist/safe.cjs" }), { available: false });
  assert.deepEqual(match([{ import: "../invalid.cjs" }, "./dist/safe.cjs"]), { available: true, targetPath: "./dist/safe.cjs" });
  assert.deepEqual(match({ types: "./dist/index.d.ts", default: null }, ".", ".", "import", true), { available: true, targetPath: "./dist/index.d.ts" });
  assert.deepEqual(match({ types: "./dist/index.d.ts", default: null }), { available: false });
  assert.deepEqual(match({ import: null, require: "./dist/safe.cjs" }, ".", ".", "require"), { available: true, targetPath: "./dist/safe.cjs" });
  assert.deepEqual(resolvePackageExport([
    { subpath: "./*", availability: "blocked", target: "./dist/*.cjs" },
    { subpath: "./feature", availability: "blocked", target: null },
  ], "./feature", "import"), { available: false });
  assert.deepEqual(match("./dist/safe.cjs", "./zero*", "./zero"), { available: false });
  assert.deepEqual(resolvePackageExport([{ subpath: ".", availability: "available" }], ".", "import"), { available: true });
});

void test("depth and node budgets cannot be bypassed with a later fallback", () => {
  let target: PackageExportTarget = "./dist/safe.cjs";
  for (let index = 0; index < 64; index += 1) { target = [target]; }
  assert.deepEqual(match(target), { available: true, targetPath: "./dist/safe.cjs" });
  assert.deepEqual(match([target, "./dist/safe.cjs"]), { available: false });
  assert.deepEqual(match([...Array<null>(10_000).fill(null), "./dist/safe.cjs"]), { available: false });
});

void test("full capability rejects selected invalid export URLs without array fallback", async () => {
  for (const invalid of ["./dist/%2f*.js", "./dist/%5c*.js", "./dist/%FF*.js"]) {
    const report = await sourceReport([invalid, "./dist/index.js"], "./*", 'import "@fixture/core/feature";');
    assert.deepEqual(ruleIds(report.diagnostics), ["architecture.source-dependencies.package-subpath-not-exported"], JSON.stringify(report));
  }
  const invalidOriginal = await sourceReport(["./dist/../outside.js", "./dist/index.js"], ".", 'import "@fixture/core";');
  assert.equal(invalidOriginal.outcome, "passed", JSON.stringify(invalidOriginal));
});

void test("inline type syntax selects runtime package exports while declaration type syntax selects types", async () => {
  for (const [statement, runtime] of [
    ['import type { Value } from "@fixture/core";', false],
    ['export type { Value } from "@fixture/core";', false],
    ['import { type Value } from "@fixture/core";', true],
    ['export { type Value } from "@fixture/core";', true],
  ] as const) {
    const report = await sourceReport({ types: "./dist/index.d.ts", default: null }, ".", statement);
    assert.equal(ruleIds(report.diagnostics).includes("architecture.source-dependencies.package-subpath-not-exported"), runtime, JSON.stringify(report));
  }
});
