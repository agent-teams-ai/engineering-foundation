import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadCapabilityConfig,
  ruleIds,
  runSourceCapability,
  sourceConfigPath,
  withCopiedFixture,
} from "./helpers/source-dependency-v2-fixture.mjs";

const mixedPackageRule =
  "architecture.source-dependencies.runtime-boundary-imports-development-workspace-package";
const exportRule = "architecture.source-dependencies.package-subpath-not-exported";
const unresolvedRule = "architecture.source-dependencies.unresolved-local-import";

function boundaryYaml({ claims = [], dependencyMode = "runtime", id, root }) {
  const packageExports = claims.length === 0
    ? ""
    : `    packageExports:\n${claims.map((claim) => `      - ${JSON.stringify(claim)}`).join("\n")}\n`;
  return `  - id: ${id}\n    dependencyMode: ${dependencyMode}\n${packageExports}    roots:\n      - ${root}\n    entrypoints:\n      - ${root}\n    allow:\n      boundaries: []\n      packages: []\n      builtins: []\n      runtimeReferences: []\n`;
}

async function configureMixedPackage(consumerRoot, options = {}) {
  const appSpecifier = options.appSpecifier ?? "@fixture/core";
  const coreRoot = join(consumerRoot, "packages", "core");
  const developmentRoot = join(coreRoot, "src", "development");
  await mkdir(developmentRoot, { recursive: true });
  await Promise.all([
    writeFile(
      join(consumerRoot, "packages", "app", "src", "index.ts"),
      `import value from ${JSON.stringify(appSpecifier)};\nexport { value };\n`,
      "utf8",
    ),
    writeFile(join(coreRoot, "src", "index.ts"), "export default 1;\n", "utf8"),
    writeFile(join(developmentRoot, "index.ts"), "export default 2;\n", "utf8"),
    writeFile(
      join(coreRoot, "package.json"),
      `${JSON.stringify({
        name: "@fixture/core",
        version: "0.0.0",
        private: true,
        type: "module",
        exports: options.exports ?? { ".": "./dist/index.js" },
      }, null, 2)}\n`,
      "utf8",
    ),
  ]);
  const boundaries = [
    boundaryYaml({ id: "app.surface", root: "packages/app/src/index.ts" }),
    ...(options.developmentOnly
      ? []
      : [boundaryYaml({
          claims: options.runtimeClaims,
          id: "core.runtime",
          root: "packages/core/src/index.ts",
        })]),
    boundaryYaml({
      claims: options.developmentClaims,
      dependencyMode: "development",
      id: "core.development",
      root: options.developmentOnly
        ? "packages/core/src"
        : "packages/core/src/development",
    }),
  ].join("");
  await writeFile(
    sourceConfigPath(consumerRoot),
    `schemaVersion: 2\nworkspace:\n  kind: pnpm\n  manifest: pnpm-workspace.yaml\npackageRoots:\n  - packages\ngovernedRoots:\n  - packages/app/src\n  - packages/core/src\nboundaries:\n${boundaries}`,
    "utf8",
  );
}

async function mixedReport(options) {
  return withCopiedFixture("v2-valid", async (consumerRoot) => {
    await configureMixedPackage(consumerRoot, options);
    return runSourceCapability(consumerRoot);
  });
}

test("full capability requires exact runtime export ownership for mixed packages", async () => {
  assert.equal((await mixedReport({ runtimeClaims: ["."] })).outcome, "passed");
  assert.deepEqual(ruleIds((await mixedReport({})).diagnostics), [mixedPackageRule]);
  assert.deepEqual(
    ruleIds((await mixedReport({ developmentClaims: ["."] })).diagnostics),
    [mixedPackageRule],
  );
  assert.deepEqual(
    ruleIds((await mixedReport({
      developmentClaims: ["."],
      developmentOnly: true,
    })).diagnostics),
    [mixedPackageRule],
  );
  assert.deepEqual(
    ruleIds((await mixedReport({
      appSpecifier: "@fixture/core/qualification.js",
      exports: {
        ".": "./dist/index.js",
        "./qualification.js": "./dist/qualification.js",
      },
      runtimeClaims: ["."],
    })).diagnostics),
    [mixedPackageRule],
  );
  assert.equal((await mixedReport({
    appSpecifier: "@fixture/core/qualification.js",
    exports: {
      ".": "./dist/index.js",
      "./qualification.js": {
        import: "./dist/qualification.js",
        default: "./dist/qualification.cjs",
      },
    },
    runtimeClaims: ["./qualification.js"],
  })).outcome, "passed");
});

test("full capability rejects duplicate, stale, wildcard, hidden, and nonportable claims", async () => {
  for (const options of [
    { developmentClaims: ["."], runtimeClaims: ["."] },
    { runtimeClaims: ["./stale.js"] },
  ]) {
    assert.equal((await mixedReport(options)).problem?.code, "SOURCE_EXPORT_BOUNDARY_INVALID");
  }
  const wildcard = await mixedReport({ runtimeClaims: ["./feature/*"] });
  assert.equal(wildcard.problem?.code, "SOURCE_ARCHITECTURE_CONFIG_INVALID");
  const hidden = await mixedReport({ appSpecifier: "@fixture/core/hidden.js", runtimeClaims: ["."] });
  assert.deepEqual(ruleIds(hidden.diagnostics), [exportRule, mixedPackageRule]);

  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const config = await readFile(sourceConfigPath(consumerRoot), "utf8");
    for (const claim of ["./con.js", "./name.js:payload", "./cafe\u0301.js"]) {
      const candidate = config.replace(
        "  - id: core.surface\n",
        `  - id: core.surface\n    packageExports:\n      - ${JSON.stringify(claim)}\n`,
      );
      await writeFile(sourceConfigPath(consumerRoot), candidate, "utf8");
      await assert.rejects(
        () => loadCapabilityConfig(consumerRoot, "architecture/foundation/source-dependencies.yaml"),
        (error) => error?.problem?.code === "SOURCE_ARCHITECTURE_CONFIG_INVALID",
      );
    }
  });
});

test("v2 dotted claims load while direct source targets honor portable identity", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await configureMixedPackage(consumerRoot, {
      appSpecifier: "@fixture/core/package.json",
      exports: {
        ".": "./dist/index.js",
        "./package.json": "./package.json",
      },
      runtimeClaims: ["./package.json"],
    });
    assert.equal((await loadCapabilityConfig(
      consumerRoot,
      "architecture/foundation/source-dependencies.yaml",
    )).boundaries.find(({ id }) => id === "core.runtime").packageExports[0], "./package.json");
    assert.equal((await runSourceCapability(consumerRoot)).outcome, "passed");
  });

  for (const target of [
    "./src/development/index.ts",
    "./src/DEV.ts",
    "./src/development/cafe\u0301.ts",
  ]) {
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      const developmentRoot = join(consumerRoot, "packages", "core", "src", "development");
      await configureMixedPackage(consumerRoot, {
        appSpecifier: "@fixture/core/qualification.js",
        exports: { "./qualification.js": { import: target, default: "./dist/index.js" } },
        runtimeClaims: ["./qualification.js"],
      });
      if (target.includes("cafe")) {
        await writeFile(join(developmentRoot, "caf\u00e9.ts"), "export default 3;\n", "utf8");
      }
      if (target === "./src/DEV.ts") {
        await writeFile(
          join(consumerRoot, "packages", "core", "src", "dev.ts"),
          "export default 4;\n",
          "utf8",
        );
        const configPath = sourceConfigPath(consumerRoot);
        const config = await readFile(configPath, "utf8");
        await writeFile(
          configPath,
          config.replace(
            "      - packages/core/src/development\n    entrypoints:",
            "      - packages/core/src/development\n      - packages/core/src/dev.ts\n    entrypoints:",
          ),
          "utf8",
        );
      }
      const report = await runSourceCapability(consumerRoot);
      assert.equal(report.problem?.code, "SOURCE_EXPORT_BOUNDARY_INVALID");
    });
  }
});

test("full capability follows Node wildcard priority and rejects empty captures", async () => {
  const precedence = await mixedReport({
    appSpecifier: "@fixture/core/abXbcd",
    exports: { "./a*bcd": "./dist/available.js", "./ab*cd": null },
  });
  assert.deepEqual(ruleIds(precedence.diagnostics), [exportRule, mixedPackageRule]);

  const empty = await mixedReport({
    appSpecifier: "@fixture/core/zero",
    exports: { "./zero*": "./dist/available.js" },
  });
  assert.deepEqual(ruleIds(empty.diagnostics), [exportRule, mixedPackageRule]);
});

async function configureGeneratedOutput(consumerRoot, schemaVersion, dependencyMode, specifier) {
  const packageRoots = schemaVersion === 2 ? "packageRoots:\n  - packages\n" : "";
  await writeFile(
    join(consumerRoot, "packages", "app", "src", "index.ts"),
    `import value from ${JSON.stringify(specifier)};\nexport { value };\n`,
    "utf8",
  );
  await writeFile(
    sourceConfigPath(consumerRoot),
    `schemaVersion: ${schemaVersion}\nworkspace:\n  kind: pnpm\n  manifest: pnpm-workspace.yaml\n${packageRoots}governedRoots:\n  - packages/app/src\n  - packages/core/src\nboundaries:\n  - id: app.surface\n    dependencyMode: ${dependencyMode}\n    roots:\n      - packages/app/src\n    entrypoints:\n      - packages/app/src/index.ts\n    allow:\n      boundaries: []\n      packages: []\n      builtins: []\n      runtimeReferences: []\n  - id: core.surface\n    roots:\n      - packages/core/src\n    entrypoints:\n      - packages/core/src/index.ts\n    allow:\n      boundaries: []\n      packages: []\n      builtins: []\n      runtimeReferences: []\n`,
    "utf8",
  );
}

test("full capability admits only canonical missing development output without cycle edges", async () => {
  for (const specifier of ["../dist/index.js:payload.js", "../dist/con.js"]) {
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      await configureGeneratedOutput(consumerRoot, 2, "development", specifier);
      assert.deepEqual(ruleIds((await runSourceCapability(consumerRoot)).diagnostics), [unresolvedRule]);
    });
  }
  for (const [schemaVersion, dependencyMode, expected] of [
    [2, "development", []],
    [2, "runtime", [unresolvedRule]],
    [1, "development", [unresolvedRule]],
  ]) {
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      await configureGeneratedOutput(consumerRoot, schemaVersion, dependencyMode, "../dist/index.js");
      const report = await runSourceCapability(consumerRoot);
      assert.deepEqual(ruleIds(report.diagnostics), expected);
      assert.equal(ruleIds(report.diagnostics).some((id) => id.includes("cycle")), false);
    });
  }
});

test("full capability rejects root and nested dist symlinks but keeps ordinary local priority", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is privilege-dependent on Windows");
    return;
  }
  for (const nested of [false, true]) {
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      await configureGeneratedOutput(
        consumerRoot,
        2,
        "development",
        nested ? "../dist/nested/index.js" : "../dist/index.js",
      );
      const dist = join(consumerRoot, "packages", "app", "dist");
      if (nested) {
        await mkdir(dist, { recursive: true });
        await symlink(tmpdir(), join(dist, "nested"), "dir");
      } else {
        await symlink(tmpdir(), dist, "dir");
      }
      const report = await runSourceCapability(consumerRoot);
      if (nested) {
        assert.deepEqual(ruleIds(report.diagnostics), [unresolvedRule]);
      } else {
        assert.equal(report.problem?.code, "SOURCE_SYMLINK_PROHIBITED");
      }
      await rm(dist, { force: true, recursive: true });
    });
  }
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await configureGeneratedOutput(consumerRoot, 2, "development", "./local.js");
    await writeFile(join(consumerRoot, "packages", "app", "src", "local.ts"), "export default 1;\n", "utf8");
    assert.equal((await runSourceCapability(consumerRoot)).outcome, "passed");
  });
});
