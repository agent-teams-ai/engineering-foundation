import assert from "node:assert/strict";
import test from "node:test";

import { assertPackageExportCoverage } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-package-export-coverage.js";

const policy = Object.freeze({
  packageName: "@fixture/library",
  packageRoot: "packages/library",
  entrypoints: Object.freeze([
    Object.freeze({
      exportPath: ".",
      declarationEntryPoint: "packages/library/dist/index.d.ts",
    }),
  ]),
  nonTypeExports: Object.freeze([]),
});

test("fails closed when versioned types conditions expose different declarations", () => {
  assert.throws(
    () =>
      assertPackageExportCoverage({
        manifest: {
          exports: {
            ".": {
              "types@>=5.2": "./dist/current.d.ts",
              types: "./dist/index.d.ts",
              default: "./dist/index.js",
            },
          },
        },
        policy,
      }),
    /multiple declaration targets/u,
  );
});

test("accepts package-level types and typings paths without a leading dot slash", () => {
  for (const field of ["types", "typings"]) {
    assert.doesNotThrow(() =>
      assertPackageExportCoverage({
        manifest: {
          [field]: "dist/index.d.ts",
          exports: {
            ".": "./dist/index.js",
          },
        },
        policy,
      })
    );
  }
});

test("rejects unsafe package-level types paths", () => {
  for (const target of [
    "../outside.d.ts",
    "/absolute.d.ts",
    "dist\\index.d.ts",
    "dist/*.d.ts",
    "dist//index.d.ts",
  ]) {
    assert.throws(
      () =>
        assertPackageExportCoverage({
          manifest: {
            types: target,
            exports: {
              ".": "./dist/index.js",
            },
          },
          policy,
        }),
      /unsupported declaration target/u,
    );
  }
});

test("still requires dot-slash declaration targets inside exports", () => {
  assert.throws(
    () =>
      assertPackageExportCoverage({
        manifest: {
          exports: {
            ".": {
              types: "dist/index.d.ts",
              default: "./dist/index.js",
            },
          },
        },
        policy,
      }),
    /unsupported declaration target/u,
  );
});
