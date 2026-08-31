import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
const unsupportedRule = "architecture.source-dependencies.unsupported-import-specifier";
const undeclaredExternalRule =
  "architecture.source-dependencies.undeclared-external-dependency";

function boundaryYaml({
  allowedPackages = [],
  claims = [],
  dependencyMode = "runtime",
  entrypoint,
  id,
  root,
}) {
  const packageExports = claims.length === 0
    ? ""
    : `    packageExports:\n${claims.map((claim) => `      - ${JSON.stringify(claim)}`).join("\n")}\n`;
  const packages = allowedPackages.length === 0
    ? "[]"
    : `\n${allowedPackages.map((packageName) => `        - ${JSON.stringify(packageName)}`).join("\n")}`;
  return `  - id: ${id}\n    dependencyMode: ${dependencyMode}\n${packageExports}    roots:\n      - ${root}\n    entrypoints:\n      - ${entrypoint}\n    allow:\n      boundaries: []\n      packages: ${packages}\n      builtins: []\n      runtimeReferences: []\n`;
}

function reportDetails(report) {
  return JSON.stringify({
    diagnostics: report.diagnostics,
    outcome: report.outcome,
    problem: report.problem,
  }, null, 2);
}

function problemPhaseCode(problem) {
  return { code: problem?.code, phase: problem?.phase };
}

async function nativeNodeExportResolution(exports, condition) {
  const consumerRoot = await mkdtemp(join(tmpdir(), "foundation-node-export-oracle-"));
  try {
    const packageRoot = join(consumerRoot, "node_modules", "@fixture", "oracle");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await Promise.all([
      writeFile(
        join(packageRoot, "package.json"),
        `${JSON.stringify({ name: "@fixture/oracle", exports })}\n`,
        "utf8",
      ),
      writeFile(join(packageRoot, "dist", "index.cjs"), "module.exports = 1;\n", "utf8"),
    ]);
    return spawnSync(
      process.execPath,
      [
        ...(condition === "import" ? ["--input-type=module"] : []),
        "--eval",
        condition === "import"
          ? 'await import("@fixture/oracle");'
          : 'require("@fixture/oracle");',
      ],
      { cwd: consumerRoot, encoding: "utf8" },
    );
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
}

async function configureMixedPackage(consumerRoot, options = {}) {
  const appSpecifier = options.appSpecifier ?? "@fixture/core";
  const appFile = options.appFile ?? "index.ts";
  const coreRoot = join(consumerRoot, "packages", "core");
  const developmentRoot = join(coreRoot, "src", "development");
  await mkdir(developmentRoot, { recursive: true });
  if (appFile !== "index.ts") {
    await rm(join(consumerRoot, "packages", "app", "src", "index.ts"));
  }
  await Promise.all([
    writeFile(
      join(consumerRoot, "packages", "app", "src", appFile),
      options.appSource ?? `import value from ${JSON.stringify(appSpecifier)};\nexport { value };\n`,
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
    boundaryYaml({
      allowedPackages: options.appAllowedPackages ?? ["@fixture/core"],
      dependencyMode: options.appDependencyMode,
      entrypoint: `packages/app/src/${appFile}`,
      id: "app.surface",
      root: "packages/app/src",
    }),
    ...(options.developmentOnly
      ? []
      : [boundaryYaml({
          claims: options.runtimeClaims,
          entrypoint: "packages/core/src/index.ts",
          id: "core.runtime",
          root: "packages/core/src/index.ts",
        })]),
    boundaryYaml({
      claims: options.developmentClaims,
      dependencyMode: "development",
      entrypoint: options.developmentOnly
        ? "packages/core/src/index.ts"
        : "packages/core/src/development/index.ts",
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

async function setAppDeclarations(consumerRoot, declarations) {
  const manifestPath = join(consumerRoot, "packages", "app", "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    delete manifest[section];
  }
  Object.assign(manifest, declarations);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function mixedReport(options) {
  return withCopiedFixture("v2-valid", async (consumerRoot) => {
    await configureMixedPackage(consumerRoot, options);
    return runSourceCapability(consumerRoot);
  });
}

test("full capability requires exact runtime export ownership for mixed packages", async () => {
  const runtimeClaim = await mixedReport({ runtimeClaims: ["."] });
  assert.equal(runtimeClaim.outcome, "passed", reportDetails(runtimeClaim));
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
  const conditionalClaim = await mixedReport({
    appSpecifier: "@fixture/core/qualification.js",
    exports: {
      ".": "./dist/index.js",
      "./qualification.js": {
        import: "./dist/qualification.js",
        default: "./dist/qualification.cjs",
      },
    },
    runtimeClaims: ["./qualification.js"],
  });
  assert.equal(conditionalClaim.outcome, "passed", reportDetails(conditionalClaim));
});

test("full capability requires an unambiguous workspace protocol binding", async () => {
  for (const specifier of ["workspace:*", "workspace:^", "workspace:~", "workspace:^0.0.0", "workspace:0.0.0"]) {
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      await configureMixedPackage(consumerRoot, { runtimeClaims: ["."] });
      await setAppDeclarations(consumerRoot, {
        dependencies: { "@fixture/core": specifier },
      });
      const report = await runSourceCapability(consumerRoot);
      assert.equal(report.outcome, "passed", `${specifier}\n${reportDetails(report)}`);
    });
  }

  for (const section of ["optionalDependencies", "peerDependencies"]) {
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      await configureMixedPackage(consumerRoot, { runtimeClaims: ["."] });
      await setAppDeclarations(consumerRoot, {
        [section]: { "@fixture/core": "workspace:*" },
      });
      const report = await runSourceCapability(consumerRoot);
      assert.equal(report.outcome, "passed", `${section}\n${reportDetails(report)}`);
    });
  }

  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await configureMixedPackage(consumerRoot, { runtimeClaims: ["."] });
    await setAppDeclarations(consumerRoot, {
      devDependencies: { "@fixture/core": "workspace:*" },
    });
    assert.equal(
      ruleIds((await runSourceCapability(consumerRoot)).diagnostics).includes(
        "architecture.source-dependencies.runtime-import-from-development-dependency",
      ),
      true,
    );
  });

  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await configureMixedPackage(consumerRoot, {
      appDependencyMode: "development",
      runtimeClaims: ["."],
    });
    await setAppDeclarations(consumerRoot, {
      devDependencies: { "@fixture/core": "workspace:*" },
    });
    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.outcome, "passed", reportDetails(report));
  });

  for (const declarations of [
    { dependencies: { "@fixture/core": "npm:is-number@7.0.0" } },
    { dependencies: { "@fixture/core": "file:../core" } },
    { dependencies: { "@fixture/core": "link:../core" } },
    { dependencies: { "@fixture/core": "https://example.invalid/core.tgz" } },
    { dependencies: { "@fixture/core": "^0.0.0" } },
    { dependencies: { "@fixture/core": "workspace:-" } },
    {
      dependencies: { "@fixture/core": "workspace:*" },
      devDependencies: { "@fixture/core": "npm:is-number@7.0.0" },
    },
    {
      dependencies: { "@fixture/core": "npm:is-number@7.0.0" },
      devDependencies: { "@fixture/core": "workspace:*" },
    },
  ]) {
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      await configureMixedPackage(consumerRoot, { runtimeClaims: ["."] });
      await setAppDeclarations(consumerRoot, declarations);
      const report = await runSourceCapability(consumerRoot);
      assert.equal(
        ruleIds(report.diagnostics).includes(
          "architecture.source-dependencies.undeclared-workspace-dependency",
        ),
        true,
        reportDetails(report),
      );
    });
  }
});

test("full capability preserves ordinary external declaration authority", async () => {
  for (const specifier of ["7.0.0", "^7.0.0", "catalog:", "catalog:default"]) {
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      await configureMixedPackage(consumerRoot, {
        appAllowedPackages: ["is-number"],
        appSource: 'import isNumber from "is-number";\nexport { isNumber };\n',
      });
      await setAppDeclarations(consumerRoot, {
        dependencies: { "is-number": specifier },
      });
      const report = await runSourceCapability(consumerRoot);
      assert.equal(report.outcome, "passed", `${specifier}\n${reportDetails(report)}`);
    });
  }

  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await configureMixedPackage(consumerRoot, {
      appAllowedPackages: ["fixture-tool"],
      appSource: 'import tool from "fixture-tool";\nexport { tool };\n',
    });
    await setAppDeclarations(consumerRoot, {
      devDependencies: { "fixture-tool": "1.2.3" },
    });
    assert.equal(
      ruleIds((await runSourceCapability(consumerRoot)).diagnostics).includes(
        "architecture.source-dependencies.runtime-import-from-development-dependency",
      ),
      true,
    );
  });

  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await configureMixedPackage(consumerRoot, {
      appAllowedPackages: ["fixture-tool"],
      appDependencyMode: "development",
      appSource: 'import tool from "fixture-tool";\nexport { tool };\n',
    });
    await setAppDeclarations(consumerRoot, {
      devDependencies: { "fixture-tool": "catalog:" },
    });
    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.outcome, "passed", reportDetails(report));
  });
});

test("full capability never treats pnpm local identities as registry externals", async () => {
  for (const [specifier, workspaceManifest] of [
    ["workspace:*", 'packages:\n  - "packages/*"\n'],
    ["link:../tool", 'packages:\n  - "packages/*"\n'],
    ["file:../tool", 'packages:\n  - "packages/*"\n'],
    ["catalog:", 'packages:\n  - "packages/*"\ncatalog:\n  fixture-tool: "link:../tool"\n'],
    ["catalog:local", 'packages:\n  - "packages/*"\ncatalogs:\n  local:\n    fixture-tool: "workspace:*"\n'],
  ]) {
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      await configureMixedPackage(consumerRoot, {
        appAllowedPackages: ["fixture-tool"],
        appSource: 'import tool from "fixture-tool";\nexport { tool };\n',
      });
      await setAppDeclarations(consumerRoot, {
        dependencies: { "fixture-tool": specifier },
      });
      await writeFile(join(consumerRoot, "pnpm-workspace.yaml"), workspaceManifest, "utf8");
      const report = await runSourceCapability(consumerRoot);
      assert.deepEqual(ruleIds(report.diagnostics), [undeclaredExternalRule], reportDetails(report));
    });
  }
});

test("full capability follows ordered Node runtime export targets", async () => {
  for (const appSource of [
    'import value from "@fixture/core";\nexport { value };\n',
    'import value = require("@fixture/core");\nexport { value };\n',
  ]) {
    const blocked = await mixedReport({
      appSource,
      exports: { ".": { node: null, default: "./dist/index.js" } },
    });
    assert.deepEqual(
      ruleIds(blocked.diagnostics),
      [exportRule, mixedPackageRule],
      appSource,
    );

    const arrayFallback = await mixedReport({
      appSource,
      exports: { ".": [null, "./dist/index.js"] },
      runtimeClaims: ["."],
    });
    assert.equal(arrayFallback.outcome, "passed", reportDetails(arrayFallback));
  }

  const defaultFirst = await mixedReport({
    exports: { ".": { default: "./dist/index.js", node: null } },
    runtimeClaims: ["."],
  });
  assert.equal(defaultFirst.outcome, "passed", reportDetails(defaultFirst));

  const moduleSyncBlocked = await mixedReport({
    exports: { ".": { "module-sync": null, default: "./dist/index.js" } },
  });
  assert.deepEqual(
    ruleIds(moduleSyncBlocked.diagnostics),
    [exportRule, mixedPackageRule],
  );

  const importBlocked = await mixedReport({
    exports: { ".": { import: null, require: "./dist/index.cjs" } },
  });
  assert.deepEqual(ruleIds(importBlocked.diagnostics), [exportRule, mixedPackageRule]);
  const requireAvailable = await mixedReport({
    appSource: 'import value = require("@fixture/core");\nexport { value };\n',
    exports: { ".": { import: null, require: "./dist/index.cjs" } },
    runtimeClaims: ["."],
  });
  assert.equal(requireAvailable.outcome, "passed", reportDetails(requireAvailable));

  const requireBlocked = await mixedReport({
    appSource: 'import value = require("@fixture/core");\nexport { value };\n',
    exports: { ".": { require: null, import: "./dist/index.js" } },
  });
  assert.deepEqual(ruleIds(requireBlocked.diagnostics), [exportRule, mixedPackageRule]);

  for (const exports of [
    { ".": "../outside.js" },
    { ".": "./dist/%2fsecret.js" },
    { ".": "./dist/%6eode_modules/entry.js" },
    { ".": "./dist/../outside.js" },
    { ".": { import: null, default: "./dist/index.js" } },
  ]) {
    const report = await mixedReport({ exports });
    assert.deepEqual(ruleIds(report.diagnostics), [exportRule, mixedPackageRule]);
  }

  const unreachableTypes = await mixedReport({ exports: {
    ".": { types: "./src/development/index.ts", default: "./dist/index.js" },
  }, runtimeClaims: ["."] });
  assert.equal(unreachableTypes.problem?.code, "SOURCE_EXPORT_BOUNDARY_INVALID", reportDetails(unreachableTypes));

  const defaultPrecedesTypes = await mixedReport({ exports: {
    ".": { default: "./dist/index.js", types: "./src/development/index.ts" },
  }, runtimeClaims: ["."] });
  assert.equal(defaultPrecedesTypes.outcome, "passed", reportDetails(defaultPrecedesTypes));

  const typesOnly = await mixedReport({ exports: { ".": { types: "./src/development/index.ts" } } });
  assert.deepEqual(ruleIds(typesOnly.diagnostics), [exportRule, mixedPackageRule]);
});

test("full capability derives static .cts export conditions without changing dynamic import", async () => {
  const staticBlocked = await mixedReport({
    appFile: "index.cts",
    exports: { ".": { import: "./dist/index.js", require: null } },
  });
  assert.deepEqual(
    ruleIds(staticBlocked.diagnostics),
    [exportRule, mixedPackageRule],
  );

  const staticAvailable = await mixedReport({
    appFile: "index.cts",
    exports: { ".": { import: null, require: "./dist/index.cjs" } },
    runtimeClaims: ["."],
  });
  assert.equal(staticAvailable.outcome, "passed", reportDetails(staticAvailable));

  const dynamicAvailable = await mixedReport({
    appFile: "index.cts",
    appSource: 'export const load = () => import("@fixture/core");\n',
    exports: { ".": { import: "./dist/index.js", require: null } },
    runtimeClaims: ["."],
  });
  assert.equal(dynamicAvailable.outcome, "passed", reportDetails(dynamicAvailable));

  const esmBlocked = await mixedReport({
    appFile: "index.mts",
    exports: { ".": { import: null, require: "./dist/index.cjs" } },
  });
  assert.deepEqual(ruleIds(esmBlocked.diagnostics), [exportRule, mixedPackageRule]);
});

async function nativeTypeScriptCtsResolution(exports) {
  const consumerRoot = await mkdtemp(join(tmpdir(), "foundation-ts-cts-oracle-"));
  try {
    const packageRoot = join(consumerRoot, "node_modules", "@fixture", "oracle");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await Promise.all([
      writeFile(
        join(packageRoot, "package.json"),
        `${JSON.stringify({ name: "@fixture/oracle", exports })}\n`,
        "utf8",
      ),
      writeFile(join(packageRoot, "dist", "import.d.mts"), "declare const value: 1; export default value;\n", "utf8"),
      writeFile(join(packageRoot, "dist", "require.d.cts"), "declare const value: 1; export = value;\n", "utf8"),
      writeFile(join(consumerRoot, "app.cts"), 'import value = require("@fixture/oracle");\nexport = value;\n', "utf8"),
    ]);
    return spawnSync(
      process.execPath,
      [
        join(process.cwd(), "node_modules", "typescript", "lib", "tsc.js"),
        "--module", "NodeNext",
        "--moduleResolution", "NodeNext",
        "--noEmit",
        "--pretty", "false",
        join(consumerRoot, "app.cts"),
      ],
      { cwd: consumerRoot, encoding: "utf8" },
    );
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
}

test("pinned TypeScript NodeNext confirms .cts require-condition authority", async () => {
  const available = await nativeTypeScriptCtsResolution({
    import: "./dist/import.d.mts",
    require: "./dist/require.d.cts",
  });
  assert.equal(available.status, 0, available.stderr || available.stdout);

  const blocked = await nativeTypeScriptCtsResolution({
    import: "./dist/import.d.mts",
    require: null,
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stdout + blocked.stderr, /Cannot find module '@fixture\/oracle'/u);
});

test("full capability uses importer package type for static TypeScript exports", async () => {
  for (const [moduleType, expected] of [
    ["commonjs", "passed"],
    ["module", "failed"],
  ]) {
    await withCopiedFixture("v2-valid", async (consumerRoot) => {
      await configureMixedPackage(consumerRoot, {
        exports: { ".": { import: null, require: "./dist/index.cjs" } },
        runtimeClaims: ["."],
      });
      const appManifestPath = join(consumerRoot, "packages", "app", "package.json");
      const appManifest = JSON.parse(await readFile(appManifestPath, "utf8"));
      appManifest.type = moduleType;
      await writeFile(appManifestPath, `${JSON.stringify(appManifest, null, 2)}\n`, "utf8");
      const report = await runSourceCapability(consumerRoot);
      if (expected === "passed") {
        assert.equal(report.outcome, "passed", reportDetails(report));
      } else {
        assert.equal(ruleIds(report.diagnostics).includes(exportRule), true, reportDetails(report));
      }
    });
  }
});

test("full capability uses the nearest containing package scope for static TypeScript exports", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await mkdir(join(consumerRoot, "packages", "app", "src", "esm"), { recursive: true });
    await writeFile(join(consumerRoot, "packages", "app", "src", "esm", "package.json"), '{"type":"module"}\n', "utf8");
    await configureMixedPackage(consumerRoot, {
      appFile: "esm/index.ts",
      exports: { ".": { import: null, require: "./dist/index.cjs" } },
    });
    const report = await runSourceCapability(consumerRoot);
    assert.equal(ruleIds(report.diagnostics).includes(exportRule), true, reportDetails(report));
  });
});

test("full capability rejects package subpath traversal before package classification", async () => {
  for (const appSpecifier of ["@fixture/core/../evil", "@fixture/core/./evil",
    "@fixture/core/%2e%2e/evil", "@fixture/core/%2fhidden", "@fixture/core/..\\evil"]) {
    const report = await mixedReport({ appSpecifier });
    assert.deepEqual(ruleIds(report.diagnostics), [unsupportedRule], reportDetails(report));
  }
});

test("full capability rejects export targets beyond the deterministic structure budget", async () => {
  let target = "./dist/index.js";
  for (let index = 0; index < 80; index += 1) {
    target = [target];
  }
  const report = await mixedReport({ exports: { ".": target } });
  assert.deepEqual(problemPhaseCode(report.problem), { code: "PACKAGE_EXPORTS_INVALID", phase: "package-manifest" });
});

test("full capability follows ordered TypeScript types export targets", async () => {
  for (const [exports, exported] of [
    [{ ".": { types: null, default: "./dist/index.js" } }, false],
    [{ ".": { default: "./dist/index.js", types: null } }, true],
    [{ ".": { types: "./dist/index.d.ts", default: null } }, true],
    [{ ".": { "module-sync": null, default: "./dist/index.d.ts" } }, true],
  ]) {
    const report = await mixedReport({
      appSource: 'import type { Value } from "@fixture/core";\nexport type { Value };\n',
      exports,
    });
    assert.equal(
      ruleIds(report.diagnostics).includes(exportRule),
      !exported,
      reportDetails(report),
    );
  }
});

test("pinned native Node confirms ordered export-target oracle cases", async () => {
  for (const condition of ["import", "require"]) {
    assert.notEqual(
      (await nativeNodeExportResolution(
        { node: null, default: "./dist/index.cjs" },
        condition,
      )).status,
      0,
    );
    assert.equal(
      (await nativeNodeExportResolution([null, "./dist/index.cjs"], condition)).status,
      0,
    );
    assert.equal(
      (await nativeNodeExportResolution(
        { default: "./dist/index.cjs", node: null },
        condition,
      )).status,
      0,
    );
    const invalid = await nativeNodeExportResolution("../outside.cjs", condition);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /ERR_INVALID_PACKAGE_TARGET/u);

    const encodedReservedSegment = await nativeNodeExportResolution(
      "./dist/%6eode_modules/entry.js",
      condition,
    );
    assert.notEqual(encodedReservedSegment.status, 0);
    assert.match(encodedReservedSegment.stderr, /ERR_INVALID_PACKAGE_TARGET/u);

    const moduleSyncBlocked = await nativeNodeExportResolution(
      { "module-sync": null, default: "./dist/index.cjs" },
      condition,
    );
    assert.notEqual(moduleSyncBlocked.status, 0);
    assert.match(moduleSyncBlocked.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/u);
  }
  assert.notEqual(
    (await nativeNodeExportResolution(
      { import: null, require: "./dist/index.cjs" },
      "import",
    )).status,
    0,
  );
  assert.equal(
    (await nativeNodeExportResolution(
      { import: null, require: "./dist/index.cjs" },
      "require",
    )).status,
    0,
  );
});

test("full capability rejects duplicate, stale, wildcard, hidden, and nonportable claims", async () => {
  for (const options of [
    { developmentClaims: ["."], runtimeClaims: ["."] },
    { runtimeClaims: ["./stale.js"] },
  ]) {
    assert.equal((await mixedReport(options)).problem?.code, "SOURCE_EXPORT_BOUNDARY_INVALID");
  }
  const wildcard = await mixedReport({ runtimeClaims: ["./feature/*"] });
  assert.deepEqual(problemPhaseCode(wildcard.problem), {
    code: "SCHEMA_INVALID",
    phase: "source-architecture-config",
  });
  const hidden = await mixedReport({ appSpecifier: "@fixture/core/hidden.js", runtimeClaims: ["."] });
  assert.deepEqual(ruleIds(hidden.diagnostics), [exportRule, mixedPackageRule]);

  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const config = await readFile(sourceConfigPath(consumerRoot), "utf8");
    for (const [claim, expectedCode] of [
      ["./con.js", "SOURCE_ARCHITECTURE_CONFIG_INVALID"],
      ["./name.js:payload", "SCHEMA_INVALID"],
      ["./cafe\u0301.js", "SCHEMA_INVALID"],
    ]) {
      const candidate = config.replace(
        "  - id: core.surface\n",
        `  - id: core.surface\n    packageExports:\n      - ${JSON.stringify(claim)}\n`,
      );
      await writeFile(sourceConfigPath(consumerRoot), candidate, "utf8");
      await assert.rejects(
        () => loadCapabilityConfig(consumerRoot, "architecture/foundation/source-dependencies.yaml"),
        (error) => {
          assert.deepEqual(problemPhaseCode(error?.problem), {
            code: expectedCode,
            phase: "source-architecture-config",
          });
          return true;
        },
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
    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.outcome, "passed", reportDetails(report));
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
  for (const specifier of [
    "../dist/index.js:payload.js",
    "../dist/con.js",
    "../dist/bad*.js",
    "../dist/bad<.js",
    "../dist/bad>.js",
    "../dist/bad|.js",
    "../dist/bad\".js",
  ]) {
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

test("full capability validates every existing generated-output filesystem kind", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await configureGeneratedOutput(consumerRoot, 2, "development", "../dist/index.js");
    const dist = join(consumerRoot, "packages", "app", "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "index.js"), "export default 1;\n", "utf8");
    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.outcome, "passed", reportDetails(report));
  });

  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await configureGeneratedOutput(consumerRoot, 2, "development", "../dist/index.js");
    await mkdir(join(consumerRoot, "packages", "app", "dist", "index.js"), {
      recursive: true,
    });
    assert.deepEqual(ruleIds((await runSourceCapability(consumerRoot)).diagnostics), [unresolvedRule]);
  });

  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await configureGeneratedOutput(consumerRoot, 2, "development", "../dist/nested/index.js");
    const dist = join(consumerRoot, "packages", "app", "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "nested"), "not a directory\n", "utf8");
    assert.deepEqual(ruleIds((await runSourceCapability(consumerRoot)).diagnostics), [unresolvedRule]);
  });
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
    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.outcome, "passed", reportDetails(report));
  });
});
