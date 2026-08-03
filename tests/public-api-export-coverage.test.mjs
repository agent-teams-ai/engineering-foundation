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
