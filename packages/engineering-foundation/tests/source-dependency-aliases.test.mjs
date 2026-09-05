import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse, stringify } from "yaml";
import { runFoundationCheck } from "../dist/check-runner.js";
import { check, withFixture } from "./support/dependency-fixtures.mjs";

const sourceId = "architecture.source-dependencies";
const declaredId = "workspace.dependency-declarations";
const rules = (report) => report.diagnostics.map(({ ruleId }) => ruleId.split(".").at(-1));

async function configure(root, schemaVersion, {
  slot = "alias", target = "@vendor/library", route = "catalog:",
  section = "dependencies", mode = "runtime", typeOnly = false,
  allowed = [slot], imported = slot, raw = `npm:${target}@1.2.3`, extra = {},
} = {}) {
  const workspacePath = join(root, "pnpm-workspace.yaml");
  const workspace = parse(await readFile(workspacePath, "utf8"));
  workspace.catalog[slot] = raw;
  workspace.catalogs = { legacy: { [slot]: raw } };
  await writeFile(workspacePath, stringify(workspace));
  await writeFile(join(root, "packages/app/package.json"), JSON.stringify({
    name: "@fixture/app", type: "module",
    [section]: { [slot]: route === "direct" ? raw : route }, ...extra,
  }));
  for (const name of ["app", "core"]) {
    await mkdir(join(root, `packages/${name}/src`), { recursive: true });
    await writeFile(join(root, `packages/${name}/src/index.ts`), name === "core"
      ? "export const core = 1;\n"
      : typeOnly ? `import type { Value } from ${JSON.stringify(imported)};\nexport type { Value };\n`
        : `import value from ${JSON.stringify(imported)};\nexport { value };\n`);
  }
  const sourcePath = "architecture/foundation/source-dependencies.yaml";
  await writeFile(join(root, sourcePath), stringify({
    schemaVersion, workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
    ...(schemaVersion === 2 ? { packageRoots: ["packages"] } : {}),
    governedRoots: ["packages/app/src", "packages/core/src"],
    boundaries: ["app", "core"].map((name) => ({
      id: `${name}.surface`, dependencyMode: name === "app" ? mode : "runtime",
      roots: [`packages/${name}/src`], entrypoints: [`packages/${name}/src/index.ts`],
      allow: { boundaries: [], packages: name === "app" ? allowed : [], builtins: [], runtimeReferences: [] },
    })),
  }));
  const foundationPath = join(root, "foundation.config.yaml");
  const foundation = parse(await readFile(foundationPath, "utf8"));
  foundation.capabilities[sourceId] = { configPath: sourcePath };
  await writeFile(foundationPath, stringify(foundation));
}

const registryCases = JSON.parse(await readFile(new URL("./fixtures/workspace-dependency-declarations/registry-alias-specifiers.json", import.meta.url), "utf8"));
async function selected(root, capabilityId) {
  const report = await runFoundationCheck({ consumerRoot: root, foundationVersion: "0.21.0", capabilityId });
  assert.equal(report.capabilities.length, 1);
  assert.equal(report.capabilities[0].capabilityId, capabilityId);
  return report.capabilities[0];
}

for (const version of [1, 2]) {
  test(`A2 review v${version} registry whitespace preserves native resolution, source and exact policy`, async () => {
    await withFixture(async (root) => {
      const installed = join(root, "packages/app/node_modules/alias");
      await mkdir(installed, { recursive: true });
      await writeFile(join(installed, "package.json"), JSON.stringify({
        name: "@vendor/library", version: "1.5.0", exports: "./index.cjs",
      }));
      await writeFile(join(installed, "index.cjs"), "module.exports = 1;\n");
      for (const route of ["direct", "catalog:", "catalog:default", "catalog:legacy"]) {
        for (const { suffix } of registryCases.filter((entry) => entry.registry && /\s/u.test(entry.suffix))) {
          await configure(root, version, { route, raw: `npm:@vendor/library@${suffix}` });
          assert.equal(createRequire(join(root, "packages/app/src/index.ts")).resolve("alias"), join(installed, "index.cjs"));
          assert.equal((await selected(root, sourceId)).outcome, "passed");
          const declared = await selected(root, declaredId);
          assert.equal(declared.outcome, "violations");
          assert.ok(rules(declared).includes("catalog-version-not-exact"));
        }
      }
    });
  });
  for (const route of ["direct", "catalog:", "catalog:default", "catalog:legacy"]) {
    test(`A2 review v${version} source-only registry grammar through ${route}`, async () => {
      await withFixture(async (root) => {
        for (const { suffix, registry } of registryCases) {
          await configure(root, version, { route, raw: `npm:@vendor/library@${suffix}` });
          const source = await selected(root, sourceId);
          assert.equal(source.outcome, registry ? "passed" : "violations", JSON.stringify({ suffix, source }));
          assert.deepEqual(rules(source), registry ? [] : ["undeclared-external-dependency"]);
          if (!registry) {
            const declared = await selected(root, declaredId);
            assert.equal(declared.outcome, "violations", JSON.stringify({ suffix, declared }));
            assert.ok(rules(declared).includes("catalog-version-not-exact"));
          }
        }
      });
    });
  }
  for (const exports of [undefined, null, { "./private": "./src/private.cjs" }, { ".": "./src/index.ts" }, { "./private": null }]) {
    test(`A2 review v${version} self alias follows Node exports ${JSON.stringify(exports)}`, async () => {
      await withFixture(async (root) => {
        await configure(root, version, {
          route: "direct", slot: "@fixture/app", imported: "@fixture/app/private",
          extra: exports === undefined ? {} : { exports },
        });
        const local = join(root, "packages/app/src/private.cjs");
        await writeFile(local, "module.exports = 1;\n");
        const installed = join(root, "packages/app/node_modules/@fixture/app");
        await mkdir(installed, { recursive: true });
        await writeFile(join(installed, "package.json"), JSON.stringify({
          name: "@vendor/library", version: "1.2.3", exports: { "./private": "./private.cjs" },
        }));
        await writeFile(join(installed, "private.cjs"), "module.exports = 2;\n");
        const resolve = () => createRequire(join(root, "packages/app/src/index.ts")).resolve("@fixture/app/private");
        const exported = exports?.["./private"] === "./src/private.cjs";
        const selfReference = exports !== undefined && exports !== null;
        if (!selfReference || exported) {
          assert.equal(resolve(), exported ? local : join(installed, "private.cjs"));
        } else {
          assert.throws(resolve, { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
        }
        const source = await selected(root, sourceId);
        assert.deepEqual(rules(source).toSorted(), !selfReference ? [] : [
          "self-package-import-boundary-unresolved",
          ...(exported ? [] : ["package-subpath-not-exported"]),
        ].toSorted());
        const declared = await selected(root, declaredId);
        assert.deepEqual(rules(declared), ["internal-dependency-without-workspace-protocol"]);
      });
    });
  }
  test(`A2 review v${version} default catalog definitions agree with pnpm`, async () => {
    await withFixture(async (root) => {
      await configure(root, version);
      const path = join(root, "pnpm-workspace.yaml");
      const original = parse(await readFile(path, "utf8"));
      for (const mode of ["catalog", "catalogs.default", "conflict", "identical", "empty", "disjoint"]) {
        const workspace = structuredClone(original);
        if (mode !== "catalog") {
          workspace.catalogs.default = mode === "empty" ? {} : mode === "disjoint" ? { other: "1.2.3" } : mode === "conflict" ? { alias: "npm:typescript@7.0.2" } : { ...workspace.catalog };
        }
        if (mode === "catalogs.default") {
          delete workspace.catalog;
        }
        await writeFile(path, stringify(workspace));
        const valid = mode === "catalog" || mode === "catalogs.default";
        for (const id of [sourceId, declaredId]) {
          const report = await selected(root, id);
          assert.equal(report.outcome, valid ? "passed" : "invalid-input", JSON.stringify({ mode, report }));
          if (!valid) {
            assert.equal(report.problem.code, "PNPM_WORKSPACE_INVALID");
            assert.equal(report.problem.phase, "workspace-manifest");
          }
        }
        const oracle = spawnSync("pnpm", ["list", "--depth", "-1", "--json"], {
          cwd: root, encoding: "utf8", shell: process.platform === "win32",
        });
        assert.equal(oracle.status, valid ? 0 : 1, JSON.stringify(oracle));
        if (!valid) {
          assert.match(oracle.stdout + oracle.stderr, /default.*catalog.*defined multiple times/u);
        }
        assert.deepEqual(parse(await readFile(path, "utf8")), workspace);
      }
    });
  });
}

const scenarios = [
  { name: "allowed scoped catalog alias", options: {}, source: [], declared: [] },
  { name: "allowed direct registry alias still requires catalog declaration", options: { route: "direct" }, source: [], declared: ["external-version-not-cataloged"] },
  { name: "allow.packages uses the slot, not target", options: { allowed: ["@vendor/library"] }, source: ["forbidden-package-dependency"], declared: [] },
  { name: "target import cannot borrow an alias declaration", options: { imported: "@vendor/library", allowed: ["@vendor/library"] }, source: ["undeclared-external-dependency"], declared: [] },
  { name: "target subpaths keep slot permission", options: { imported: "alias/subpath" }, source: [], declared: [] },
  { name: "runtime use of dev alias fails", options: { target: "typescript", section: "devDependencies" }, source: ["runtime-import-from-development-dependency"], declared: [] },
  { name: "development source uses dev alias", options: { target: "typescript", section: "devDependencies", mode: "development" }, source: [], declared: [] },
  { name: "type-only source uses dev alias", options: { target: "typescript", section: "devDependencies", typeOnly: true }, source: [], declared: [] },
  { name: "declared dev-only target fails runtime placement", options: { target: "typescript" }, source: [], declared: ["development-only-package-in-runtime-section"] },
  { name: "optional alias is a runtime declaration", options: { section: "optionalDependencies" }, source: [], declared: [] },
  { name: "peer alias is a runtime declaration", options: { section: "peerDependencies" }, source: [], declared: [] },
  { name: "registry alias to workspace name stays external", options: { target: "@fixture/core" }, source: [], declared: ["internal-dependency-without-workspace-protocol"] },
  { name: "workspace slot shadowed by registry alias stays external", options: { slot: "@fixture/core" }, source: [], declared: ["internal-dependency-without-workspace-protocol"] },
  { name: "same-name registry alias stays external", options: { slot: "@fixture/core", target: "@fixture/core" }, source: [], declared: ["internal-dependency-without-workspace-protocol"] },
  { name: "alias to missing reserved target fails declarations", options: { target: "@fixture/missing" }, source: [], declared: ["reserved-scope-package-not-in-workspace"] },
  { name: "registry and local declarations cannot mix", options: { slot: "@fixture/core", extra: { devDependencies: { "@fixture/core": "workspace:*" } } }, source: ["undeclared-external-dependency"], declared: ["dependency-declared-multiple-times", "internal-dependency-without-workspace-protocol"] },
  { name: "conflicting alias targets cannot supply declaration authority", options: { extra: { devDependencies: { alias: "npm:other@1.2.3" } } }, source: ["undeclared-external-dependency"], declared: ["dependency-declared-multiple-times", "external-version-not-cataloged"] },
  { name: "malformed alias cannot supply declaration authority", options: { raw: "npm:@broken@1.2.3" }, source: ["undeclared-external-dependency"], declared: ["catalog-version-not-exact", "catalog-version-not-exact"] },
];

for (const version of [1, 2]) {
  for (const scenario of scenarios) {
    test(`v${version} declared/observed: ${scenario.name}`, async () => {
      await withFixture(async (root) => {
        await configure(root, version, scenario.options);
        const report = await runFoundationCheck({ consumerRoot: root, foundationVersion: "0.21.0" });
        assert.equal(report.problem, undefined, JSON.stringify(report));
        for (const [id, expected] of [[sourceId, scenario.source], [declaredId, scenario.declared]]) {
          const capability = report.capabilities.find(({ capabilityId }) => capabilityId === id);
          assert.equal(capability.outcome, expected.length === 0 ? "passed" : "violations", JSON.stringify(capability));
          assert.deepEqual(rules(capability).toSorted(), expected.toSorted(), JSON.stringify(capability));
        }
      });
    });
  }
  for (const route of ["direct", "catalog:", "catalog:default", "catalog:legacy"]) {
    test(`v${version} source CLI slot shadowing through ${route}`, async () => {
      await withFixture(async (root) => {
        await configure(root, version, { slot: "@fixture/core", route });
        const source = check(root, sourceId);
        assert.equal(source.result.status, 0, JSON.stringify(source.report));
        const declarations = check(root, declaredId);
        assert.equal(declarations.result.status, 1, JSON.stringify(declarations.report));
        assert.deepEqual(rules(declarations.report.capabilities[0]), ["internal-dependency-without-workspace-protocol"]);
      });
    });
  }
  test(`v${version} both CLI gates accept an allowed alias and reject prohibited usage`, async () => {
    await withFixture(async (root) => {
      await configure(root, version, { route: "catalog:legacy" });
      assert.equal(check(root).result.status, 0);
      await configure(root, version, { target: "typescript", section: "devDependencies" });
      const negative = check(root);
      assert.equal(negative.result.status, 1);
      assert.deepEqual(rules(negative.report.capabilities.find(({ capabilityId }) => capabilityId === sourceId)), ["runtime-import-from-development-dependency"]);
    });
  });
}
