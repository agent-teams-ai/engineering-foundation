import type { SourceWorkspaceTopology } from "../../packages/engineering-foundation/src/capabilities/source-dependencies/application/model/source-workspace-topology.js";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import test from "node:test";
import {
  sourceConfigPath,
  withCopiedFixture,
  withTemporaryDirectory,
  inspectV2Topology,
} from "../helpers/source-dependency-v2-fixture.mjs";
interface BoundarySelection {
  name: string;
  schemaVersion: number;
  packageRoots?: string[];
  noGlobs?: boolean;
  rootPackage?: boolean;
}
interface BoundaryFixture {
  consumerRoot: string;
  appRoot: string;
  src: string;
  policy: {
    schemaVersion: number;
    workspace: { kind: string; manifest: string };
    packageRoots?: string[];
    governedRoots: string[];
    boundaries: ReturnType<typeof sourceBoundary>[];
  };
  save: () => Promise<void>;
}
interface SourceReport {
  capabilityConfigSchemaVersion?: number;
  diagnostics: Array<{ ruleId: string; location: { path: string } }>;
  problem?: { code: string };
}
export async function governExplicitSourceRoot(
  consumerRoot: string,
  root: string,
  schemaVersion = 2,
) {
  const configPath = sourceConfigPath(consumerRoot);
  const config = await readFile(configPath, "utf8");
  const governed = config
    .replace("governedRoots:\n", `governedRoots:\n  - ${root}\n`)
    .replace(
      "  - id: app.surface\n    roots:\n",
      `  - id: app.surface\n    roots:\n      - ${root}\n`,
    );
  await writeFile(
    configPath,
    schemaVersion === 2
      ? governed
      : governed
          .replace("schemaVersion: 2", "schemaVersion: 1")
          .replace("packageRoots:\n  - packages\n", ""),
    "utf8",
  );
  await writeFile(
    join(consumerRoot, "foundation.config.yaml"),
    "schemaVersion: 1\nproject:\n  id: explicit-source-root-fixture\ncapabilities:\n  architecture.source-dependencies:\n    configPath: architecture/foundation/source-dependencies.yaml\n",
    "utf8",
  );
}

export const boundarySelections: BoundarySelection[] = [
  { name: "v1", schemaVersion: 1 },
  { name: "v2 collection", schemaVersion: 2, packageRoots: ["packages"] },
  { name: "v2 individual", schemaVersion: 2, packageRoots: ["packages/app", "packages/core"] },
  {
    name: "v2 collection without globs",
    schemaVersion: 2,
    packageRoots: ["packages"],
    noGlobs: true,
  },
  {
    name: "v2 individual without globs",
    schemaVersion: 2,
    packageRoots: ["packages/app", "packages/core"],
    noGlobs: true,
  },
  { name: "v1 root package", schemaVersion: 1, rootPackage: true },
];
export const generatedSourceRoutes = [
  "coverage",
  "dist",
  "coverage/nested/dist",
  "dist/nested/coverage",
];

function sourceBoundary(id: string, root: string, packages: string[] = []) {
  return {
    id,
    roots: [root],
    entrypoints: [`${root}/index.ts`],
    allow: { boundaries: [], packages, builtins: ["node:path"], runtimeReferences: [] },
  };
}

export async function withBoundaryFixture(
  selection: BoundarySelection,
  callback: (fixture: BoundaryFixture) => Promise<void>,
) {
  const withFixture = selection.rootPackage
    ? withTemporaryDirectory
    : (run: (root: string) => Promise<void>) => withCopiedFixture("v2-valid", run);
  await withFixture(async (consumerRoot) => {
    const appRoot = selection.rootPackage ? "." : "packages/app";
    const src = posix.join(appRoot, "src");
    const policy = {
      schemaVersion: selection.schemaVersion,
      workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
      ...(selection.packageRoots === undefined ? {} : { packageRoots: selection.packageRoots }),
      governedRoots: selection.rootPackage ? [src] : [appRoot, "packages/core/src"],
      boundaries: [
        sourceBoundary("app.surface", src, selection.rootPackage ? [] : ["@fixture/core"]),
      ],
    };
    if (selection.rootPackage) {
      await writeSourceFixture(
        consumerRoot,
        "package.json",
        JSON.stringify({
          name: "@fixture/root",
          version: "0.0.0",
          private: true,
          type: "module",
          exports: { ".": "./dist/index.js" },
        }),
      );
      await writeSourceFixture(consumerRoot, `${src}/index.ts`);
    } else {
      policy.boundaries.push(sourceBoundary("core.surface", "packages/core/src"));
    }
    if (selection.rootPackage || selection.noGlobs) {
      await writeSourceFixture(consumerRoot, "pnpm-workspace.yaml", "{}\n");
    }
    await writeSourceFixture(
      consumerRoot,
      "foundation.config.yaml",
      JSON.stringify({
        schemaVersion: 1,
        project: { id: "boundary-source-fixture" },
        capabilities: {
          "architecture.source-dependencies": {
            configPath: "architecture/foundation/source-dependencies.yaml",
          },
        },
      }),
    );
    const save = () =>
      writeSourceFixture(
        consumerRoot,
        "architecture/foundation/source-dependencies.yaml",
        `${JSON.stringify(policy)}\n`,
      );
    await save();
    await callback({ consumerRoot, appRoot, src, policy, save });
  });
}

function assertForbiddenSource(report: SourceReport, path: string) {
  assert.deepEqual(
    report.diagnostics.map(({ ruleId, location }) => ({ ruleId, path: location.path })),
    [
      { ruleId: "architecture.source-dependencies.forbidden-package-dependency", path },
      { ruleId: "architecture.source-dependencies.undeclared-external-dependency", path },
    ],
  );
}

export function registerSourceBoundaryCases(
  checkWithCli: (root: string, expectedStatus: number) => SourceReport,
) {
  // The finite relation matrix is: generated directory equals/ancestors B; B is
  // a directory or file; E is inside B or another root of that same boundary.
  // Broad parent B alone keeps package output pruned (separate control below).
  for (const selection of boundarySelections) {
    for (const route of generatedSourceRoutes) {
      test(`${selection.name} CLI governed scope discovers explicit boundary ${route}`, async () => {
        await withBoundaryFixture(
          selection,
          async ({ consumerRoot, appRoot, src, policy, save }) => {
            const root = posix.join(appRoot, route);
            const path = `${root}/hidden.ts`;
            const sibling = posix.join(appRoot, route.startsWith("coverage") ? "dist" : "coverage");
            if (selection.rootPackage) {
              // The immutable schemas reject literal '.'. V1 can govern named
              // directories owned by the root manifest without governing '.'.
              policy.governedRoots = [src, route.split("/")[0]];
            }
            // V1 already scans all of its broad governed root, including output.
            if (selection.schemaVersion === 2) {
              await writeSourceFixture(
                consumerRoot,
                `${sibling}/generated.ts`,
                'import "outside-policy";\n',
              );
            }
            for (const relationship of ["directory", "entrypoint", "file"]) {
              policy.boundaries[0].roots = [src, relationship === "file" ? path : root];
              policy.boundaries[0].entrypoints = [
                relationship === "directory" ? `${src}/index.ts` : path,
              ];
              await save();
              await writeSourceFixture(consumerRoot, path, 'import "node:path";\n');
              const positive = checkWithCli(consumerRoot, 0);
              assert.equal(positive.capabilityConfigSchemaVersion, selection.schemaVersion);
              assert.deepEqual(positive.diagnostics, []);
              if (selection.schemaVersion === 2) {
                const topology: SourceWorkspaceTopology = await inspectV2Topology(consumerRoot);
                assert.deepEqual(
                  topology.packages.flatMap(({ sourcePaths }) => sourcePaths).toSorted(),
                  [
                    path,
                    `${src}/index.ts`,
                    ...(selection.rootPackage ? [] : ["packages/core/src/index.ts"]),
                  ].toSorted(),
                );
              }
              await writeSourceFixture(consumerRoot, path, 'import "outside-policy";\n');
              assertForbiddenSource(checkWithCli(consumerRoot, 1), path);
            }
          },
        );
      });
    }
  }

  test("CLI parent boundary roots preserve output pruning and fail closed on excluded entrypoints", async () => {
    for (const selection of boundarySelections.filter(
      ({ noGlobs, rootPackage, name }) => !noGlobs && !rootPackage && !name.includes("individual"),
    )) {
      for (const route of ["coverage", "dist"]) {
        await withBoundaryFixture(selection, async ({ consumerRoot, appRoot, policy, save }) => {
          const path = posix.join(appRoot, route, "hidden.ts");
          policy.boundaries[0].roots = [appRoot];
          await save();
          await writeSourceFixture(consumerRoot, path, 'import "node:path";\n');
          assert.deepEqual(checkWithCli(consumerRoot, 0).diagnostics, []);
          await writeSourceFixture(consumerRoot, path, 'import "outside-policy";\n');
          if (selection.schemaVersion === 1) {
            assertForbiddenSource(checkWithCli(consumerRoot, 1), path);
          } else {
            assert.deepEqual(checkWithCli(consumerRoot, 0).diagnostics, []);
          }
          policy.boundaries[0].entrypoints = [path];
          await save();
          for (const forbidden of [false, true]) {
            await writeSourceFixture(
              consumerRoot,
              path,
              forbidden ? 'import "outside-policy";\n' : 'import "node:path";\n',
            );
            const report = checkWithCli(
              consumerRoot,
              selection.schemaVersion === 1 && !forbidden ? 0 : 1,
            );
            if (selection.schemaVersion === 2) {
              assert.deepEqual(
                report.diagnostics.map(({ ruleId }) => ruleId),
                ["architecture.source-dependencies.invalid-boundary-entrypoint"],
              );
            } else if (forbidden) {
              assertForbiddenSource(report, path);
            }
          }
        });
      }
    }
  });

  test("CLI boundary roots cannot expand governed or selected package scope", async () => {
    for (const selection of [boundarySelections[0], boundarySelections[1]]) {
      const relationships =
        selection.schemaVersion === 1
          ? ["sibling", "parent"]
          : ["sibling", "parent", "outside-selection"];
      for (const relationship of relationships) {
        await withBoundaryFixture(selection, async ({ consumerRoot, policy, save }) => {
          const root =
            relationship === "outside-selection" ? "tools/coverage" : "packages/app/coverage";
          const path = `${root}/hidden.ts`;
          policy.governedRoots = [
            relationship === "outside-selection" ? "tools" : "packages/app/src",
            "packages/core/src",
          ];
          policy.boundaries[0].roots = [relationship === "parent" ? "packages/app" : root];
          policy.boundaries[0].entrypoints = [path];
          await save();
          for (const forbidden of [false, true]) {
            await writeSourceFixture(
              consumerRoot,
              path,
              forbidden ? 'import "outside-policy";\n' : 'import "node:path";\n',
            );
            const report = checkWithCli(consumerRoot, 2);
            assert.ok(report.problem);
            assert.equal(
              report.problem.code,
              relationship === "outside-selection"
                ? "SOURCE_ROOT_OUTSIDE_WORKSPACE"
                : "SOURCE_ARCHITECTURE_CONFIG_INVALID",
            );
            assert.deepEqual(report.diagnostics, []);
          }
        });
      }
    }
  });

  test("CLI root manifest inventory does not select its generated-name source", async () => {
    await withBoundaryFixture(boundarySelections[1], async ({ consumerRoot, policy, save }) => {
      const path = "coverage/nested/dist/hidden.ts";
      for (const selected of [false, true]) {
        if (selected) {
          policy.governedRoots.push("coverage");
          policy.boundaries.push(sourceBoundary("root.surface", "coverage"));
          const lastBoundary = policy.boundaries.at(-1);
          assert.ok(lastBoundary);
          lastBoundary.entrypoints = [path];
        }
        await save();
        for (const source of ['import "node:path";\n', 'import "outside-policy";\n']) {
          await writeSourceFixture(consumerRoot, path, source);
          const report = checkWithCli(consumerRoot, selected ? 2 : 0);
          assert.deepEqual(report.diagnostics, []);
          if (selected) {
            assert.ok(report.problem);
            assert.equal(report.problem.code, "SOURCE_ROOT_OUTSIDE_WORKSPACE");
          }
        }
      }
    });
  });
}

export async function writeSourceFixture(
  consumerRoot: string,
  path: string,
  source = "export const value = true;\n",
) {
  const absolutePath = join(consumerRoot, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, source, "utf8");
}
