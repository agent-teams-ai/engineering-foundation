import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import {
  addWorkspacePackage,
  configProblem,
  foundationPackageRoot,
  loadCapabilityConfig,
  ruleIds,
  runSourceCapability,
  signalThatFailsAfterConfiguration,
  sourceArchitectureConfig,
  sourceConfigPath,
  withCopiedFixture,
  withTemporaryDirectory,
} from "./helpers/source-dependency-v2-fixture.mjs";

test("source architecture schema v2 is strict and explicit while v1 stays loadable", async () => {
  const schema = JSON.parse(
    await readFile(
      join(
        foundationPackageRoot,
        "schemas",
        "architecture-source-dependencies",
        "v2.schema.json",
      ),
      "utf8",
    ),
  );
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const input = {
    schemaVersion: 2,
    workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
    packageRoots: ["packages"],
    governedRoots: ["packages/app/src"],
    boundaries: [
      {
        id: "app.surface",
        roots: ["packages/app/src"],
        entrypoints: ["packages/app/src/index.ts"],
        allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] },
      },
    ],
  };
  assert.equal(validate(input), true, JSON.stringify(validate.errors));
  const { packageRoots: _packageRoots, ...withoutPackageRoots } = input;
  assert.equal(validate(withoutPackageRoots), false);
  assert.equal(validate({ ...input, packageRoots: ["packages/*"] }), false);

  await withTemporaryDirectory(async (consumerRoot) => {
    await Promise.all(
      [1, 2, 3].map((version) =>
        writeFile(
          join(consumerRoot, `v${version}.yaml`),
          sourceArchitectureConfig(version),
          "utf8",
        ),
      ),
    );
    const v1 = await loadCapabilityConfig(consumerRoot, "v1.yaml");
    assert.equal(v1.schemaVersion, 1);
    assert.equal(v1.boundaries[0].dependencyMode, "runtime");
    assert.deepEqual(v1.boundaries[0].entrypoints, ["packages/app/src/index.ts"]);
    assert.equal((await loadCapabilityConfig(consumerRoot, "v2.yaml")).schemaVersion, 2);
    await writeFile(
      join(consumerRoot, "missing-entrypoints.yaml"),
      sourceArchitectureConfig(1).replace("    entrypoints:\n      - packages/app/src/index.ts\n", ""),
      "utf8",
    );
    await assert.rejects(
      () => loadCapabilityConfig(consumerRoot, "missing-entrypoints.yaml"),
      (error) => error?.name === "CapabilityInputError",
    );
    await assert.rejects(
      () => loadCapabilityConfig(consumerRoot, "v3.yaml"),
      (error) => error?.problem?.code === "SOURCE_ARCHITECTURE_CONFIG_INVALID",
    );
  });
});

function overlappingBoundaryConfig(schemaVersion, boundaryIds) {
  const roots = { alpha: "packages/app/src", beta: "packages/app/src/domain" };
  const packageRoots = schemaVersion === 2 ? "packageRoots:\n  - packages\n" : "";
  return `schemaVersion: ${schemaVersion}\nworkspace:\n  kind: pnpm\n  manifest: pnpm-workspace.yaml\n${packageRoots}governedRoots:\n  - packages/app/src\nboundaries:\n${boundaryIds
    .map(
      (id) => `  - id: ${id}\n    roots:\n      - ${roots[id]}\n    entrypoints: []\n    allow:\n      boundaries: []\n      packages: []\n      builtins: []\n      runtimeReferences: []`,
    )
    .join("\n")}\n`;
}

test("v2 rejects boundary overlap deterministically while v1 keeps specificity", async () => {
  await withTemporaryDirectory(async (consumerRoot) => {
    await Promise.all([
      writeFile(
        join(consumerRoot, "first.yaml"),
        overlappingBoundaryConfig(2, ["beta", "alpha"]),
        "utf8",
      ),
      writeFile(
        join(consumerRoot, "second.yaml"),
        overlappingBoundaryConfig(2, ["alpha", "beta"]),
        "utf8",
      ),
      writeFile(
        join(consumerRoot, "v1.yaml"),
        overlappingBoundaryConfig(1, ["beta", "alpha"]),
        "utf8",
      ),
      writeFile(
        join(consumerRoot, "governed.yaml"),
        sourceArchitectureConfig(2).replace(
          "  - packages/app/src\n",
          "  - packages/app/src\n  - packages/app/src/domain\n",
        ),
        "utf8",
      ),
    ]);
    const problems = [];
    for (const path of ["first.yaml", "second.yaml"]) {
      await assert.rejects(
        () => loadCapabilityConfig(consumerRoot, path),
        (error) => {
          problems.push(error?.problem);
          return error?.problem?.code === "SOURCE_BOUNDARY_AMBIGUOUS";
        },
      );
    }
    assert.deepEqual(problems[0], problems[1]);
    assert.equal((await loadCapabilityConfig(consumerRoot, "v1.yaml")).schemaVersion, 1);
    await assert.rejects(
      () => loadCapabilityConfig(consumerRoot, "governed.yaml"),
      (error) => error?.problem?.code === "SOURCE_ARCHITECTURE_CONFIG_INVALID",
    );
  });
});

function portableOverlapConfig(governedRoots, boundaryRoots) {
  return `schemaVersion: 2\nworkspace:\n  kind: pnpm\n  manifest: pnpm-workspace.yaml\npackageRoots:\n  - packages\ngovernedRoots:\n${governedRoots
    .map((root) => `  - ${JSON.stringify(root)}`)
    .join("\n")}\nboundaries:\n${boundaryRoots
    .map(
      ({ id, root }) => `  - id: ${id}\n    roots:\n      - ${JSON.stringify(root)}\n    entrypoints: []\n    allow:\n      boundaries: []\n      packages: []\n      builtins: []\n      runtimeReferences: []`,
    )
    .join("\n")}\n`;
}

test("v2 root overlap identity is portable, NFC-normalized, and segment-aware", async () => {
  await withTemporaryDirectory(async (consumerRoot) => {
    const collisionPairs = [
      ["packages/App/src", "packages/app/src"],
      ["packages/App", "packages/app/src"],
      ["packages/caf\u00e9/src", "packages/cafe\u0301/src"],
      ["packages/app//src/", "packages/app/src"],
    ];
    for (const [index, [left, right]] of collisionPairs.entries()) {
      const boundaries = [
        { id: "alpha", root: left },
        { id: "beta", root: right },
      ];
      const first = await configProblem(
        consumerRoot,
        `governed-${index}-a.yaml`,
        portableOverlapConfig([left, right], boundaries),
      );
      const second = await configProblem(
        consumerRoot,
        `governed-${index}-b.yaml`,
        portableOverlapConfig([right, left], boundaries.toReversed()),
      );
      assert.equal(first?.code, "SOURCE_ARCHITECTURE_CONFIG_INVALID");
      assert.deepEqual(first, second);

      const boundaryFirst = await configProblem(
        consumerRoot,
        `boundary-${index}-a.yaml`,
        portableOverlapConfig(["packages"], boundaries),
      );
      const boundarySecond = await configProblem(
        consumerRoot,
        `boundary-${index}-b.yaml`,
        portableOverlapConfig(["packages"], boundaries.toReversed()),
      );
      assert.ok(
        boundaryFirst?.code === "SOURCE_BOUNDARY_AMBIGUOUS" ||
          boundaryFirst?.code === "SOURCE_ARCHITECTURE_CONFIG_INVALID",
      );
      assert.deepEqual(boundaryFirst, boundarySecond);
    }

    const distinct = portableOverlapConfig(
      ["packages/app/src", "packages/application/src"],
      [
        { id: "app", root: "packages/app/src" },
        { id: "application", root: "packages/application/src" },
      ],
    );
    await writeFile(join(consumerRoot, "distinct.yaml"), distinct, "utf8");
    assert.equal(
      (await loadCapabilityConfig(consumerRoot, "distinct.yaml")).schemaVersion,
      2,
    );
  });
});

test("v2 catches a forgotten fourth package while v1 remains externally loadable", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    assert.equal((await runSourceCapability(consumerRoot)).outcome, "passed");
    await addWorkspacePackage(consumerRoot, "fourth");
    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.outcome, "violations");
    assert.deepEqual(
      report.diagnostics.map(({ ruleId, subject, location }) => ({
        ruleId,
        subject,
        path: location.path,
      })),
      [
        {
          ruleId: "architecture.source-dependencies.uncovered-workspace-package-root",
          subject: "packages/fourth",
          path: "packages/fourth/package.json",
        },
      ],
    );
  });
  await withCopiedFixture("valid", async (consumerRoot) => {
    await addWorkspacePackage(consumerRoot, "fourth");
    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.capabilityConfigSchemaVersion, 1);
    assert.equal(report.outcome, "passed");
  });
});

test("v2 requires every boundary to belong to exactly one npm package", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await writeFile(
      sourceConfigPath(consumerRoot),
      `schemaVersion: 2
workspace:
  kind: pnpm
  manifest: pnpm-workspace.yaml
packageRoots:
  - packages
governedRoots:
  - packages/app/src
  - packages/core/src
boundaries:
  - id: shared.surface
    roots:
      - packages/app/src
      - packages/core/src
    entrypoints:
      - packages/app/src/index.ts
      - packages/core/src/index.ts
    allow:
      boundaries: []
      packages:
        - "@fixture/core"
      builtins: []
      runtimeReferences: []
`,
      "utf8",
    );
    const report = await runSourceCapability(consumerRoot);
    assert.equal(report.outcome, "invalid-input");
    assert.equal(report.problem.code, "SOURCE_BOUNDARY_SPANS_PACKAGES");
  });
});

test("v2 rejects the reverse of the adapter-to-core architecture edge", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await mkdir(join(consumerRoot, "packages", "app", "src", "adapter"));
    await Promise.all([
      writeFile(
        join(consumerRoot, "packages", "app", "src", "index.ts"),
        'import { adapterValue } from "./adapter/index.js";\nexport const appValue = adapterValue;\n',
        "utf8",
      ),
      writeFile(
        join(consumerRoot, "packages", "app", "src", "adapter", "index.ts"),
        'export const adapterValue = "adapter";\n',
        "utf8",
      ),
      writeFile(
        sourceConfigPath(consumerRoot),
        `schemaVersion: 2
workspace:
  kind: pnpm
  manifest: pnpm-workspace.yaml
packageRoots:
  - packages
governedRoots:
  - packages/app/src
  - packages/core/src
boundaries:
  - id: app.core
    roots:
      - packages/app/src/index.ts
    entrypoints:
      - packages/app/src/index.ts
    allow:
      boundaries: []
      packages: []
      builtins: []
      runtimeReferences: []
  - id: app.adapter
    roots:
      - packages/app/src/adapter
    entrypoints:
      - packages/app/src/adapter/index.ts
    allow:
      boundaries:
        - app.core
      packages: []
      builtins: []
      runtimeReferences: []
  - id: core.surface
    roots:
      - packages/core/src
    entrypoints:
      - packages/core/src/index.ts
    allow:
      boundaries: []
      packages: []
      builtins: []
      runtimeReferences: []
`,
        "utf8",
      ),
    ]);
    const report = await runSourceCapability(consumerRoot);
    assert.deepEqual(ruleIds(report.diagnostics), [
      "architecture.source-dependencies.forbidden-boundary-dependency",
    ]);
  });
});

test("v2 rejects cross-package relative imports even across an allowed boundary edge", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "packages", "app", "src", "index.ts"),
      'import { coreValue } from "../../core/src/index.js";\nexport const appValue = coreValue;\n',
      "utf8",
    );
    const configPath = sourceConfigPath(consumerRoot);
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        "  - id: app.surface\n    roots:\n      - packages/app/src\n    entrypoints:\n      - packages/app/src/index.ts\n    allow:\n      boundaries: []",
        "  - id: app.surface\n    roots:\n      - packages/app/src\n    entrypoints:\n      - packages/app/src/index.ts\n    allow:\n      boundaries:\n        - core.surface",
      ),
      "utf8",
    );
    const report = await runSourceCapability(consumerRoot);
    assert.deepEqual(ruleIds(report.diagnostics), [
      "architecture.source-dependencies.cross-package-relative-import",
    ]);
  });
});

test("v2 rejects hidden workspace subpaths", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    await Promise.all([
      writeFile(
        join(consumerRoot, "packages", "app", "src", "index.ts"),
        'import { hiddenValue } from "@fixture/core/hidden";\nexport const appValue = hiddenValue;\n',
        "utf8",
      ),
      writeFile(
        join(consumerRoot, "packages", "core", "src", "hidden.ts"),
        'export const hiddenValue = "hidden";\n',
        "utf8",
      ),
    ]);
    const report = await runSourceCapability(consumerRoot);
    assert.deepEqual(ruleIds(report.diagnostics), [
      "architecture.source-dependencies.package-subpath-not-exported",
    ]);
  });
});

test("v2 workspace imports require both manifest and architecture authority", async () => {
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const manifestPath = join(consumerRoot, "packages", "app", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.dependencies;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    assert.deepEqual(ruleIds((await runSourceCapability(consumerRoot)).diagnostics), [
      "architecture.source-dependencies.undeclared-workspace-dependency",
    ]);
  });
  await withCopiedFixture("v2-valid", async (consumerRoot) => {
    const configPath = sourceConfigPath(consumerRoot);
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace('      packages:\n        - "@fixture/core"', "      packages: []"),
      "utf8",
    );
    assert.deepEqual(ruleIds((await runSourceCapability(consumerRoot)).diagnostics), [
      "architecture.source-dependencies.forbidden-package-dependency",
    ]);
  });
});

function runTypeOnlyCycleFixture(writeOrder) {
  return withCopiedFixture("v2-valid", async (consumerRoot) => {
    const appSource = join(consumerRoot, "packages", "app", "src", "index.ts");
    const coreSource = join(consumerRoot, "packages", "core", "src", "index.ts");
    const coreManifestPath = join(consumerRoot, "packages", "core", "package.json");
    const coreManifest = JSON.parse(await readFile(coreManifestPath, "utf8"));
    coreManifest.dependencies = { "@fixture/app": "workspace:*" };
    const writes = {
      app: () => writeFile(
        appSource,
        'import type { CoreType } from "@fixture/core";\nexport interface AppType { readonly core?: CoreType }\n',
        "utf8",
      ),
      core: () => writeFile(
        coreSource,
        'import type { AppType } from "@fixture/app";\nexport interface CoreType { readonly app?: AppType }\n',
        "utf8",
      ),
    };
    for (const key of writeOrder) {
      await writes[key]();
    }
    await writeFile(coreManifestPath, `${JSON.stringify(coreManifest, null, 2)}\n`, "utf8");
    const configPath = sourceConfigPath(consumerRoot);
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        "  - id: core.surface\n    roots:\n      - packages/core/src\n    entrypoints:\n      - packages/core/src/index.ts\n    allow:\n      boundaries: []\n      packages: []",
        '  - id: core.surface\n    roots:\n      - packages/core/src\n    entrypoints:\n      - packages/core/src/index.ts\n    allow:\n      boundaries: []\n      packages:\n        - "@fixture/app"',
      ),
      "utf8",
    );
    return (await runSourceCapability(consumerRoot)).diagnostics;
  });
}

test("v2 rejects type-only package cycles deterministically", async () => {
  const first = await runTypeOnlyCycleFixture(["app", "core"]);
  const second = await runTypeOnlyCycleFixture(["core", "app"]);
  assert.deepEqual(first, second);
  assert.deepEqual(ruleIds(first), [
    "architecture.source-dependencies.package-type-only-cycle",
  ]);
});

test("reports the requested v1 and v2 schema version on success, failure, and cancellation", async () => {
  for (const [fixture, schemaVersion] of [
    ["valid", 1],
    ["v2-valid", 2],
  ]) {
    await withCopiedFixture(fixture, async (consumerRoot) => {
      const passed = await runSourceCapability(consumerRoot);
      assert.equal(passed.outcome, "passed");
      assert.equal(passed.capabilityConfigSchemaVersion, schemaVersion);

      const configPath = sourceConfigPath(consumerRoot);
      const config = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        config.replace("kind: pnpm", "kind: invalid"),
        "utf8",
      );
      const invalid = await runSourceCapability(consumerRoot);
      assert.equal(invalid.outcome, "invalid-input");
      assert.equal(invalid.capabilityConfigSchemaVersion, schemaVersion);

      await writeFile(configPath, config, "utf8");
      const failed = await runSourceCapability(
        consumerRoot,
        signalThatFailsAfterConfiguration(),
      );
      assert.equal(failed.outcome, "failed");
      assert.equal(failed.problem.code, "UNEXPECTED_FAILURE");
      assert.equal(failed.capabilityConfigSchemaVersion, schemaVersion);

      const controller = new AbortController();
      controller.abort();
      const cancelled = await runSourceCapability(consumerRoot, controller.signal);
      assert.equal(cancelled.outcome, "cancelled");
      assert.equal(cancelled.problem.code, "EXECUTION_CANCELLED");
      assert.equal(cancelled.capabilityConfigSchemaVersion, schemaVersion);
    });
  }
});
