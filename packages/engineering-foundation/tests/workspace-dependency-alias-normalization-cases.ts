import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  normalizeDependencyDeclaration,
  parseNpmAlias,
} from "../dist/workspace-inventory/application/policies/normalize-dependency-declaration.js";
const registryCases = JSON.parse(
  await readFile(
    new URL(
      "./fixtures/workspace-dependency-declarations/registry-alias-specifiers.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
for (const { suffix, registry } of registryCases) {
  test(`A2 review registry alias normalization: ${suffix}`, () => {
    const raw = `npm:@vendor/library@${suffix}`;
    assert.deepEqual(
      parseNpmAlias(raw),
      registry
        ? {
            targetPackageName: "@vendor/library",
            versionSpecifier: suffix,
          }
        : undefined,
    );
    for (const specifier of [raw, "catalog:", "catalog:default", "catalog:legacy"]) {
      const actual = normalizeDependencyDeclaration({
        catalogs: ["default", "legacy"].map((catalogName) => ({
          catalogName,
          dependencyName: "alias",
          version: raw,
        })),
        dependencyName: "alias",
        manifestPath: "packages/app/package.json",
        packageName: "@fixture/app",
        section: "dependencies",
        specifier,
      });
      assert.equal(actual.specifier, specifier);
      assert.equal(actual.dependencyName, "alias");
      assert.equal(actual.effectiveSpecifier, raw);
      assert.deepEqual(
        actual.provenance,
        specifier === raw
          ? { kind: "manifest" }
          : {
              kind: "catalog",
              catalogName: specifier === "catalog:legacy" ? "legacy" : "default",
            },
      );
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
      catalogName: "default",
      dependencyName: "alias",
      version,
    }));
    for (const entries of [catalogs, catalogs.toReversed()]) {
      assert.throws(
        () =>
          normalizeDependencyDeclaration({
            catalogs: entries,
            dependencyName: "alias",
            packageName: "@fixture/app",
            manifestPath: "packages/app/package.json",
            section: "dependencies",
            specifier: "catalog:",
          }),
        { name: "TypeError", message: "Catalog default declares alias more than once." },
      );
    }
  }
});
