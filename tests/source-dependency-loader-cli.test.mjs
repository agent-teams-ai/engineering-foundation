import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePackage = join(repositoryRoot, "packages", "engineering-foundation");
const packageInput = process.env.LOADER_PACKED_PACKAGE_ROOT ?? sourcePackage;
const capabilityId = "architecture.source-dependencies";

async function write(root, path, contents) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), typeof contents === "string" ? contents : JSON.stringify(contents));
}

// Execute the complete CLI from its own installed package tree, never from source.
// A packed extraction can replace packageInput without changing test expectations.
async function withInstalledCli(callback) {
  const root = await mkdtemp(join(tmpdir(), "foundation-loader-cli-"));
  const installed = join(root, "node_modules", "@agent-teams", "engineering-foundation");
  try {
    const manifest = JSON.parse(await readFile(join(packageInput, "package.json"), "utf8"));
    for (const name of ["dist", "schemas", "package.json"]) {
      await cp(join(packageInput, name), join(installed, name), { recursive: true });
    }
    for (const name of Object.keys(manifest.dependencies)) {
      const target = await realpath(join(sourcePackage, "node_modules", name));
      const link = join(installed, "node_modules", name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    }
    await callback(root, join(installed, manifest.bin["agent-teams-foundation"]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function boundary(id, root, options = {}) {
  return { id, roots: [root], entrypoints: [`${root}/index.ts`], allow: {
    boundaries: options.boundaries ?? [], packages: options.packages ?? [],
    builtins: options.builtins ?? [], runtimeReferences: options.runtimeReferences ?? [],
  } };
}

async function fixture(root, schemaVersion, options = {}) {
  const config = {
    schemaVersion, workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
    ...(schemaVersion === 2 ? { packageRoots: ["packages"] } : {}),
    governedRoots: ["packages/app/src", "packages/core/src"],
    boundaries: [
      boundary("app.a", "packages/app/src/a", options),
      boundary("app.b", "packages/app/src/b", { boundaries: options.reverse ? ["app.a"] : [] }),
      boundary("core", "packages/core/src"),
    ],
  };
  await write(root, "package.json", { name: "loader-fixture", private: true });
  await write(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  await write(root, "foundation.config.yaml", { schemaVersion: 1, project: { id: "loader-fixture" },
    capabilities: { [capabilityId]: { configPath: "source.yaml" } } });
  await write(root, "source.yaml", config);
  for (const name of ["app", "core"]) {
    await write(root, `packages/${name}/package.json`, { name: `@fixture/${name}`, private: true,
      version: "1.0.0", type: "module", exports: { ".": "./src/index.ts" },
      ...(name === "app" ? { dependencies: { "@fixture/core": "workspace:*" } } : {}),
    });
  }
  await write(root, "packages/app/src/a/index.ts", options.source ?? 'module.require("@fixture/core");');
  await write(root, "packages/app/src/b/index.ts", options.other ?? "export const value = 1;");
  await write(root, "packages/core/src/index.ts", "export type Value = string; export const value = 1;");
}

async function check(root, cli, expectedRules) {
  const watched = ["source.yaml", "foundation.config.yaml", "packages/app/src/a/index.ts", "packages/app/src/b/index.ts"];
  const before = await Promise.all(watched.map((path) => readFile(join(root, path))));
  const result = spawnSync(process.execPath, [cli, "check", "--consumer", root, "--json"], {
    cwd: root, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, expectedRules.length === 0 ? 0 : 1, result.stdout);
  assert.equal(report.coverage, "full");
  assert.equal(report.capabilities.length, 1);
  assert.equal(report.capabilities[0].capabilityId, capabilityId);
  assert.deepEqual(report.capabilities[0].diagnostics.map(({ ruleId }) => ruleId).toSorted(),
    expectedRules.map((rule) => `${capabilityId}.${rule}`).toSorted(), result.stdout);
  const after = await Promise.all(watched.map((path) => readFile(join(root, path))));
  assert.deepEqual(after, before, "CLI must preserve consumer source and policy bytes");
  return report;
}

for (const schemaVersion of [1, 2]) {
  test(`installed CLI v${schemaVersion}: loader edges, exceptions, and cycles`, async (t) => {
    await withInstalledCli(async (root, cli) => {
      const loaders = [
        ['direct require', 'require("@fixture/core");'],
        ['module.require', 'module.require("@fixture/core");'],
        ['require alias', 'const load = require; load("@fixture/core");'],
        ['createRequire', 'import { createRequire } from "node:module"; createRequire(import.meta.url)("@fixture/core");'],
        ['builtin getter', 'process.getBuiltinModule("module").createRequire(import.meta.url)("@fixture/core");'],
        ['type edge', 'import type { Value } from "@fixture/core";'],
      ];
      for (const [name, source] of loaders) {
        await t.test(`${name} forbidden and allowed`, async () => {
          const options = { source, builtins: ["node:module"] };
          await fixture(root, schemaVersion, options);
          await check(root, cli, ["forbidden-package-dependency"]);
          await fixture(root, schemaVersion, { ...options, packages: ["@fixture/core"] });
          await check(root, cli, []);
        });
      }
      await t.test("shadowed APIs are admitted", async () => {
        await fixture(root, schemaVersion, { source: `
declare function require(name: string): unknown;
require("not-a-package");
function f(module, process) { module.require("user"); process.getBuiltinModule("user"); }
const createRequire = (base) => (name) => name; createRequire(import.meta.url)("user");` });
        await check(root, cli, []);
      });
      for (const [name, source, kind] of [
        ["dynamic import", 'import(selected);', "dynamic"],
        ["nonliteral loader", 'module.require(selected);', "commonjs"],
        ["written alias", 'let load = require; load = user; load("@fixture/core");', "commonjs"],
        ["different base", 'import { createRequire } from "node:module"; createRequire("/different/base.cjs")("@fixture/core");', "commonjs"],
      ]) {
        await t.test(`${name} requires exact runtimeReferences exception`, async () => {
          const options = { source, builtins: ["node:module"] };
          await fixture(root, schemaVersion, options);
          await check(root, cli, ["unresolved-runtime-reference"]);
          await fixture(root, schemaVersion, { ...options, runtimeReferences: [kind] });
          await check(root, cli, []);
          await fixture(root, schemaVersion, { ...options, runtimeReferences: [kind === "commonjs" ? "dynamic" : "commonjs"] });
          await check(root, cli, ["unresolved-runtime-reference"]);
        });
      }
      await t.test("runtime loader cycle", async () => {
        await fixture(root, schemaVersion, { source: 'module.require("../b/index.js");',
          other: 'const load = require; load("../a/index.js");', boundaries: ["app.b"], reverse: true });
        await check(root, cli, ["boundary-runtime-cycle"]);
      });
      await t.test("type-only cycle", async () => {
        await fixture(root, schemaVersion, { source: 'export type { Value } from "../b/index.js";',
          other: 'export type { Value } from "../a/index.js";', boundaries: ["app.b"], reverse: true });
        await check(root, cli, ["boundary-type-only-cycle"]);
      });
    });
  });
}

test("installed CLI never guesses a different createRequire base, as witnessed by Node", async () => {
  await withInstalledCli(async (root, cli) => {
    const source = `import { createRequire } from "node:module";
createRequire(import.meta.url)("./dep.cjs");
createRequire(new URL("../b/index.ts", import.meta.url))("./dep.cjs");`;
    await fixture(root, 2, { source, builtins: ["node:module"] });
    await write(root, "packages/app/src/a/dep.cjs", 'module.exports = "a";');
    await write(root, "packages/app/src/b/dep.cjs", 'module.exports = "b";');
    // Native runtime expectations come from distinct fixture bytes, not parser output.
    assert.equal(createRequire(join(root, "packages/app/src/a/index.ts"))("./dep.cjs"), "a");
    assert.equal(createRequire(join(root, "packages/app/src/b/index.ts"))("./dep.cjs"), "b");
    await check(root, cli, ["unresolved-runtime-reference"]);
    const config = JSON.parse(await readFile(join(root, "source.yaml"), "utf8"));
    config.boundaries[0].allow.runtimeReferences = ["commonjs"];
    await write(root, "source.yaml", config);
    await check(root, cli, []);
  });
});
