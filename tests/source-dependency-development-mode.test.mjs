import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distRoot = process.env.FOUNDATION_DIST_ROOT ?? join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
);
const { evaluateSourceDependencies } = await import(
  pathToFileURL(
    join(
      distRoot,
      "capabilities/source-dependencies/application/policies/evaluate-source-dependencies.js",
    ),
  ).href
);

function boundary(dependencyMode, allowedPackages) {
  return {
    id: "app.specifications",
    dependencyMode,
    roots: ["packages/app/specifications"],
    entrypoints: [],
    allowedBoundaries: [],
    allowedPackages,
    allowedBuiltins: [],
    allowedRuntimeReferences: [],
  };
}

function edge(packageName, declaration) {
  return {
    fromPath: "packages/app/specifications/index.ts",
    fromBoundaryId: "app.specifications",
    fromWorkspacePackageName: "@fixture/app",
    fromWorkspacePackageManifestPath: "packages/app/package.json",
    kind: "static",
    mode: "runtime",
    specifier: packageName,
    start: 0,
    end: packageName.length,
    resolution: { kind: "external-package", packageName, declaration },
  };
}

function diagnostics(sourceBoundary, edges) {
  return evaluateSourceDependencies({
    policy: {
      schemaVersion: 1,
      workspaceManifestPath: "pnpm-workspace.yaml",
      governedRoots: ["packages"],
      boundaries: [sourceBoundary],
    },
    graph: {
      nodes: [],
      edges,
      parseFailures: [],
      unclassifiedSourcePaths: [],
      unresolvedRuntimeReferences: [],
    },
  });
}

function ruleIds(values) {
  return values.map(({ ruleId }) => ruleId).toSorted();
}

function localBoundary(id, dependencyMode, allowedBoundaries) {
  return {
    ...boundary(dependencyMode, []),
    id,
    roots: [`packages/app/${id}`],
    allowedBoundaries,
  };
}

function localEdge(sourceBoundary, targetBoundary) {
  return {
    ...edge(`../${targetBoundary.id}/index.js`, "runtime"),
    fromPath: `${sourceBoundary.roots[0]}/index.ts`,
    fromBoundaryId: sourceBoundary.id,
    resolution: {
      kind: "local-file",
      path: `${targetBoundary.roots[0]}/index.ts`,
      workspacePackageName: "@fixture/app",
      workspacePackageManifestPath: "packages/app/package.json",
      targetBoundaryId: targetBoundary.id,
    },
  };
}

function boundaryGraphDiagnostics(boundaries, edges) {
  return evaluateSourceDependencies({
    policy: {
      schemaVersion: 1,
      workspaceManifestPath: "pnpm-workspace.yaml",
      governedRoots: ["packages"],
      boundaries,
    },
    graph: {
      nodes: [],
      edges,
      parseFailures: [],
      unclassifiedSourcePaths: [],
      unresolvedRuntimeReferences: [],
    },
  });
}

test("runtime boundary rejects a runtime import from devDependencies", () => {
  assert.deepEqual(
    ruleIds(diagnostics(boundary("runtime", ["fixture-tool"]), [edge("fixture-tool", "development")])),
    ["architecture.source-dependencies.runtime-import-from-development-dependency"],
  );
});

test("development boundary admits declared allowlisted development and production dependencies", () => {
  assert.deepEqual(
    diagnostics(boundary("development", ["fixture-tool", "fixture-runtime"]), [
      edge("fixture-tool", "development"),
      edge("fixture-runtime", "runtime"),
    ]),
    [],
  );
});

test("development boundary still rejects undeclared and forbidden packages", () => {
  assert.deepEqual(
    ruleIds(
      diagnostics(boundary("development", ["missing-tool"]), [
        edge("missing-tool", "undeclared"),
        edge("forbidden-tool", "development"),
      ]),
    ),
    [
      "architecture.source-dependencies.forbidden-package-dependency",
      "architecture.source-dependencies.undeclared-external-dependency",
    ],
  );
});

test("runtime boundary cannot import an allowed development boundary", () => {
  const runtime = localBoundary("runtime", "runtime", ["specification"]);
  const development = localBoundary("specification", "development", []);
  const observed = boundaryGraphDiagnostics(
    [runtime, development],
    [localEdge(runtime, development)],
  );
  assert.equal(
    ruleIds(observed).filter(
      (ruleId) =>
        ruleId ===
        "architecture.source-dependencies.runtime-boundary-imports-development-boundary",
    ).length,
    1,
  );
});

test("runtime source cannot reach a development boundary through a runtime wrapper", () => {
  const application = localBoundary("application", "runtime", ["wrapper"]);
  const wrapper = localBoundary("wrapper", "runtime", ["specification"]);
  const development = localBoundary("specification", "development", []);
  const observed = boundaryGraphDiagnostics(
    [application, wrapper, development],
    [localEdge(application, wrapper), localEdge(wrapper, development)],
  );
  const blocked = observed.filter(
    ({ ruleId }) =>
      ruleId ===
      "architecture.source-dependencies.runtime-boundary-imports-development-boundary",
  );
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].subject, "wrapper->specification");
});
