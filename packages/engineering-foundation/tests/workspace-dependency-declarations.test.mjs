import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";

import { createWorkspaceDependencyDeclarationsCapability } from "../dist/capabilities/workspace-dependency-declarations/module.js";
import { PnpmWorkspaceInventoryReader } from "../dist/workspace-inventory/adapters/outbound/pnpm/pnpm-workspace-inventory-reader.js";
import { check, withFixture } from "./support/dependency-fixtures.mjs";
import { normalizeDependencyDeclaration, parseNpmAlias } from "../dist/workspace-inventory/application/policies/normalize-dependency-declaration.js";

const configPath = "architecture/foundation/dependency-declarations.yaml";
const run = (consumerRoot) => createWorkspaceDependencyDeclarationsCapability(new PnpmWorkspaceInventoryReader()).run({ consumerRoot, configPath });
const rule = (suffix) => `workspace.dependency-declarations.${suffix}`;
const has = (report, suffix, slot, section = "dependencies") => report.diagnostics.some(
  (entry) => entry.ruleId === rule(suffix) && entry.subject === `@fixture/app:${section}:${slot}`,
);

async function configure(root, { slot = "alias", target = "typescript", version = "7.0.2", route = "catalog:", section = "dependencies", bundle, policy = {} } = {}) {
  const raw = `npm:${target}@${version}`;
  const workspace = parse(await readFile(join(root, "pnpm-workspace.yaml"), "utf8"));
  workspace.catalog[slot] = raw;
  workspace.catalogs = { legacy: { [slot]: raw } };
  await writeFile(join(root, "pnpm-workspace.yaml"), stringify(workspace));
  const config = parse(await readFile(join(root, configPath), "utf8"));
  Object.assign(config.policies, policy);
  await writeFile(join(root, configPath), stringify(config));
  await writeFile(join(root, "packages/app/package.json"), JSON.stringify({
    name: "@fixture/app", [section]: { [slot]: route === "direct" ? raw : route },
    ...(bundle === undefined ? {} : { [bundle]: [slot] }),
  }));
}

for (const route of ["direct", "catalog:", "catalog:legacy"]) {
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    test(`development-only alias target: ${route} in ${section}`, async () => {
      await withFixture(async (root) => {
        await configure(root, { route, section });
        const report = await run(root);
        assert.equal(has(report, "development-only-package-in-runtime-section", "alias", section), section !== "devDependencies", JSON.stringify(report));
        if (section === "devDependencies" && route !== "direct") {
          assert.equal(report.outcome, "passed");
        }
        if (route === "direct") {
          assert.equal(has(report, "external-version-not-cataloged", "alias", section), true);
        }
      });
    });
  }
  test(`exact-registry alias cannot acquire a direct-pin exception: ${route}`, async () => {
    await withFixture(async (root) => {
      await configure(root, { route, target: "@agent-teams/engineering-foundation", version: "0.1.1", section: "devDependencies" });
      assert.equal(has(await run(root), "exact-registry-development-only-package-version-not-exact", "alias", "devDependencies"), true);
    });
  });
  test(`reserved targets behind ${route} retain their identity`, async () => {
    await withFixture(async (root) => {
      await configure(root, { route, target: "@fixture/missing" });
      assert.equal(has(await run(root), "reserved-scope-package-not-in-workspace", "alias"), true);
    });
  });
}

for (const bundle of ["bundleDependencies", "bundledDependencies"]) {
  test(`${bundle} resolves declared slots to development-only targets`, async () => {
    await withFixture(async (root) => {
      await configure(root, { bundle, section: "devDependencies" });
      const report = await run(root);
      assert.deepEqual(report.diagnostics.map(({ ruleId }) => ruleId), [rule("development-only-package-bundled")]);
      await configure(root, { bundle, target: "ajv", version: "8.20.0" });
      assert.equal((await run(root)).outcome, "passed");
      const path = join(root, "packages/app/package.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      for (const value of [true, false]) {
        manifest[bundle] = value;
        await writeFile(path, JSON.stringify(manifest));
        assert.equal((await run(root)).outcome, "invalid-input");
      }
    });
  });
}

for (const [slot, suffix] of [["typescript", "development-only-package-in-runtime-section"], ["@fixture/missing", "reserved-scope-package-not-in-workspace"], ["@fixture/core", "internal-dependency-without-workspace-protocol"], ["@agent-teams/engineering-foundation", "exact-registry-development-only-package-version-not-exact"]]) {
  test(`protected slot ${slot} cannot be repurposed by an alias`, async () => {
    await withFixture(async (root) => {
      await configure(root, { slot, target: "ajv", version: "8.20.0" });
      assert.equal(has(await run(root), suffix, slot), true);
    });
  });
}

test("catalog lookup retains slot, target, raw specifier and effective version", async () => {
  await withFixture(async (root) => {
    await configure(root, { target: "@vendor/library", version: "1.2.3-rc.1+build.2", route: "catalog:legacy" });
    const inventory = await new PnpmWorkspaceInventoryReader().read(root, "pnpm-workspace.yaml");
    const declaration = inventory.packages.find(({ name }) => name === "@fixture/app").dependencies[0];
    assert.deepEqual({ slot: declaration.dependencyName, raw: declaration.specifier, target: declaration.targetPackageName, effective: declaration.effectiveSpecifier, version: declaration.effectiveVersionSpecifier, provenance: declaration.provenance }, {
      slot: "alias", raw: "catalog:legacy", target: "@vendor/library", effective: "npm:@vendor/library@1.2.3-rc.1+build.2", version: "1.2.3-rc.1+build.2", provenance: { kind: "catalog", catalogName: "legacy" },
    });
    assert.equal((await run(root)).outcome, "passed");
    const path = join(root, "pnpm-workspace.yaml");
    const workspace = parse(await readFile(path, "utf8"));
    workspace.catalogs.legacy = { "@vendor/library": "1.2.3" };
    await writeFile(path, stringify(workspace));
    assert.equal(has(await run(root), "catalog-reference-missing", "alias"), true);
  });
});

for (const target of ["@fixture/core", "@fixture/missing"]) {
  test(`registry alias does not acquire workspace origin: ${target}`, async () => {
    await withFixture(async (root) => {
      await configure(root, { target });
      assert.equal(has(await run(root), target.endsWith("/core") ? "internal-dependency-without-workspace-protocol" : "reserved-scope-package-not-in-workspace", "alias"), true);
    });
  });
}

for (const specifier of ["npm:", "npm:foo", "npm:@scope@1.2.3", "npm:@scope/pkg@", "npm:foo@^1.2.3", "npm:foo@latest", "npm:foo@npm:bar@1.2.3", "npm:foo@1.0.0-01"]) {
  test(`catalog rejects malformed or non-exact alias ${specifier}`, async () => {
    await withFixture(async (root) => {
      await configure(root);
      const path = join(root, "pnpm-workspace.yaml");
      const workspace = parse(await readFile(path, "utf8"));
      workspace.catalog.alias = specifier;
      await writeFile(path, stringify(workspace));
      assert.ok((await run(root)).diagnostics.some(({ ruleId }) => ruleId === rule("catalog-version-not-exact")));
    });
  });
}

// Captured by executing originalBase, independent of the migrated loader/parser.
const configBaseline = JSON.parse(await readFile(new URL("./fixtures/workspace-dependency-declarations/config-baseline.json", import.meta.url), "utf8"));
const configSchema = JSON.parse(await readFile(new URL("../schemas/workspace-dependency-declarations/v1.schema.json", import.meta.url), "utf8"));
import { parseCapabilityConfig } from "../dist/capabilities/workspace-dependency-declarations/contract/config.js";
import { loadCapabilityConfig } from "../dist/capabilities/workspace-dependency-declarations/adapters/inbound/filesystem/load-capability-config.js";
for (const entry of configBaseline.cases) {
  test(`original-base config byte/diagnostic parity: ${entry.name}`, async () => {
    await withFixture(async (root) => {
      const path = join(root, configPath);
      await writeFile(path, entry.yaml);
      const settings = async (operation) => {
        if (entry.problem) {
          await assert.rejects(operation, (error) => {
            assert.deepEqual(error.problem, entry.problem);
            return true;
          });
        } else {
          const actual = await operation();
          assert.equal(JSON.stringify(actual), JSON.stringify(entry.settings));
          assert.ok(Object.isFrozen(actual.policy.developmentOnlyPackages));
        }
      };
      await settings(() => loadCapabilityConfig(root, configPath));
      if (!entry.loaderOnly) {
        await settings(async () => parseCapabilityConfig(parse(entry.yaml), configSchema));
      }
      assert.equal(await readFile(path, "utf8"), entry.yaml);
    });
  });
}

test("rejects development-only and reserved targets hidden behind npm aliases", async () => {
  await withFixture(async (consumerRoot) => {
    const config = parse(await readFile(join(consumerRoot, configPath), "utf8"));
    config.policies.reservedScopes.push("@agent-teams/");
    await writeFile(join(consumerRoot, configPath), stringify(config));
    await writeFile(
      join(consumerRoot, "pnpm-workspace.yaml"),
      `packages:\n  - "packages/*"\ncatalogMode: strict\ncatalog:\n  ajv: 8.20.0\n  foundation-catalog-alias: npm:@agent-teams/engineering-foundation@0.1.1\n  previous-ajv: npm:ajv@8.19.0\n  oxlint: 1.76.0\n  typescript: 7.0.2\ncatalogs:\n  legacy:\n    foundation-named-alias: npm:@agent-teams/engineering-foundation@0.1.1\n`,
      "utf8",
    );
    await writeFile(
      join(consumerRoot, "packages", "app", "package.json"),
      `${JSON.stringify({
        name: "@fixture/app",
        version: "0.0.0",
        dependencies: {
          "foundation-direct-alias": "npm:@agent-teams/engineering-foundation@0.1.1",
          "foundation-catalog-alias": "catalog:",
          "foundation-named-alias": "catalog:legacy",
        },
        bundledDependencies: ["foundation-direct-alias"],
      }, null, 2)}\n`,
      "utf8",
    );
    const { report } = check(consumerRoot);
    const diagnostics = report.capabilities[0].diagnostics;
    for (const slot of [
      "foundation-direct-alias",
      "foundation-catalog-alias",
      "foundation-named-alias",
    ]) {
      const subject = `@fixture/app:dependencies:${slot}`;
      assert.equal(diagnostics.some(({ ruleId, subject: actual }) =>
        ruleId.endsWith("development-only-package-in-runtime-section") && actual === subject), true);
      assert.equal(diagnostics.some(({ ruleId, subject: actual }) =>
        ruleId.endsWith("exact-registry-development-only-package-version-not-exact") && actual === subject), true);
      assert.equal(diagnostics.some(({ ruleId, subject: actual }) =>
        ruleId.endsWith("reserved-scope-package-not-in-workspace") && actual === subject), true);
    }
    assert.equal(diagnostics.some(({ ruleId, subject }) =>
      ruleId.endsWith("development-only-package-bundled") &&
      subject === "@fixture/app:bundle:foundation-direct-alias"), true);
  });
});


const declarationBaseline = JSON.parse(await readFile(new URL("./fixtures/workspace-dependency-declarations/declarations-baseline.json", import.meta.url), "utf8"));
for (const entry of declarationBaseline.cases) {
  test(`original-base declaration diagnostic parity: ${entry.name}`, async () => {
    await withFixture(async (root) => {
      await writeFile(join(root, "packages/app/package.json"), JSON.stringify(entry.manifest));
      assert.deepEqual(await run(root), entry.report);
    });
  });
}

const registryCases = JSON.parse(await readFile(new URL("./fixtures/workspace-dependency-declarations/registry-alias-specifiers.json", import.meta.url), "utf8"));
for (const { suffix, registry } of registryCases) {
  test(`A2 review registry alias normalization: ${suffix}`, () => {
    const raw = `npm:@vendor/library@${suffix}`;
    assert.deepEqual(parseNpmAlias(raw), registry ? {
      targetPackageName: "@vendor/library", versionSpecifier: suffix,
    } : undefined);
    for (const specifier of [raw, "catalog:", "catalog:default", "catalog:legacy"]) {
      const actual = normalizeDependencyDeclaration({
        catalogs: ["default", "legacy"].map((catalogName) => ({ catalogName, dependencyName: "alias", version: raw })),
        dependencyName: "alias", manifestPath: "packages/app/package.json",
        packageName: "@fixture/app", section: "dependencies", specifier,
      });
      assert.equal(actual.specifier, specifier);
      assert.equal(actual.dependencyName, "alias");
      assert.equal(actual.effectiveSpecifier, raw);
      assert.deepEqual(actual.provenance, specifier === raw ? { kind: "manifest" } : {
        kind: "catalog", catalogName: specifier === "catalog:legacy" ? "legacy" : "default",
      });
      assert.equal(actual.normalizationProblem, registry ? undefined : "invalid-npm-alias");
      assert.ok(Object.isFrozen(actual));
      if (registry) {
        assert.equal(actual.targetPackageName, "@vendor/library");
        assert.equal(actual.effectiveVersionSpecifier, suffix);
      }
    }
  });
}

test("A2 review normalization rejects ambiguous catalog keys in either order", () => {
  for (const second of ["npm:typescript@7.0.2", "npm:@vendor/library@1.2.3"]) {
    const catalogs = ["npm:@vendor/library@1.2.3", second].map((version) => ({
      catalogName: "default", dependencyName: "alias", version,
    }));
    for (const entries of [catalogs, catalogs.toReversed()]) {
      assert.throws(() => normalizeDependencyDeclaration({
        catalogs: entries, dependencyName: "alias", packageName: "@fixture/app",
        manifestPath: "packages/app/package.json", section: "dependencies", specifier: "catalog:",
      }), { name: "TypeError", message: "Catalog default declares alias more than once." });
    }
  }
});
