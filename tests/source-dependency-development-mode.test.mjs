import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const foundationPackageRoot = join(repositoryRoot, "packages", "engineering-foundation");
const distRoot = process.env.FOUNDATION_DIST_ROOT ?? join(
  foundationPackageRoot,
  "dist",
);
const [{ evaluateSourceDependencies }, { NodeSourceDependencyResolver }] = await Promise.all([
  import(
    pathToFileURL(
      join(distRoot, "capabilities/source-dependencies/application/policies/evaluate-source-dependencies.js"),
    ).href
  ),
  import(
    pathToFileURL(
      join(distRoot, "capabilities/source-dependencies/adapters/outbound/node/node-source-dependency-resolver.js"),
    ).href
  ),
]);

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

function workspacePackageEdge(sourceBoundary, targetName, mode = "runtime") {
  return {
    ...edge(targetName, "runtime"),
    fromPath: `${sourceBoundary.roots[0]}/index.ts`,
    fromBoundaryId: sourceBoundary.id,
    mode,
    resolution: {
      kind: "workspace-package",
      workspacePackageName: targetName,
      workspacePackageManifestPath: "packages/target/package.json",
      declaration: "runtime",
      exported: true,
      subpath: ".",
    },
  };
}

function workspacePackageDiagnostics(sourceBoundary, targetBoundaries, mode = "runtime") {
  const targetName = "@fixture/target";
  return evaluateSourceDependencies({
    policy: {
      schemaVersion: 1,
      workspaceManifestPath: "pnpm-workspace.yaml",
      governedRoots: ["packages"],
      boundaries: [sourceBoundary, ...targetBoundaries],
    },
    graph: {
      nodes: [
        {
          path: `${sourceBoundary.roots[0]}/index.ts`,
          boundaryId: sourceBoundary.id,
          workspacePackageName: "@fixture/app",
          workspacePackageManifestPath: "packages/app/package.json",
        },
        ...targetBoundaries.map((target, index) => ({
          path: `${target.roots[0]}/file-${index}.ts`,
          boundaryId: target.id,
          workspacePackageName: targetName,
          workspacePackageManifestPath: "packages/target/package.json",
        })),
      ],
      edges: [workspacePackageEdge(sourceBoundary, targetName, mode)],
      parseFailures: [],
      unclassifiedSourcePaths: [],
      unresolvedRuntimeReferences: [],
    },
  });
}

function v2WorkspacePackageDiagnostics(sourceBoundary, targetBoundaries, options = {}) {
  const targetName = "@fixture/target";
  const importedSubpath = options.subpath ?? ".";
  const observedEdge = workspacePackageEdge(sourceBoundary, targetName, options.mode);
  observedEdge.specifier = importedSubpath === "." ? targetName : `${targetName}${importedSubpath.slice(1)}`;
  observedEdge.resolution.subpath = importedSubpath;
  return evaluateSourceDependencies({
    policy: {
      schemaVersion: 2,
      workspaceManifestPath: "pnpm-workspace.yaml",
      packageRoots: ["packages"],
      governedRoots: ["packages"],
      boundaries: [sourceBoundary, ...targetBoundaries],
    },
    graph: {
      nodes: targetBoundaries.map((target, index) => ({
        path: `${target.roots[0]}/file-${index}.ts`,
        boundaryId: target.id,
        workspacePackageName: targetName,
        workspacePackageManifestPath: "packages/target/package.json",
      })),
      edges: [observedEdge],
      parseFailures: [],
      unclassifiedSourcePaths: [],
      unresolvedRuntimeReferences: [],
    },
    packageExportBoundaries: options.authority,
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

test("runtime boundary rejects a package containing a development boundary", () => {
  const source = localBoundary("application", "runtime", []);
  source.allowedPackages = ["@fixture/target"];
  const development = localBoundary("target-development", "development", []);
  assert.deepEqual(ruleIds(workspacePackageDiagnostics(source, [development])), [
    "architecture.source-dependencies.runtime-boundary-imports-development-workspace-package",
  ]);
});

test("runtime boundary also rejects a type-only import into a development package", () => {
  const source = localBoundary("application", "runtime", []);
  source.allowedPackages = ["@fixture/target"];
  const development = localBoundary("target-development", "development", []);
  assert.deepEqual(ruleIds(workspacePackageDiagnostics(source, [development], "type-only")), [
    "architecture.source-dependencies.runtime-boundary-imports-development-workspace-package",
  ]);
});

test("development source may import a development package when declared and allowed", () => {
  const source = localBoundary("tooling", "development", []);
  source.allowedPackages = ["@fixture/target"];
  const development = localBoundary("target-development", "development", []);
  assert.deepEqual(workspacePackageDiagnostics(source, [development]), []);
});

test("runtime source may import a pure runtime package", () => {
  const source = localBoundary("application", "runtime", []);
  source.allowedPackages = ["@fixture/target"];
  const runtime = localBoundary("target-runtime", "runtime", []);
  assert.deepEqual(workspacePackageDiagnostics(source, [runtime]), []);
});

test("a runtime wrapper cannot hide a development boundary in its package", () => {
  const source = localBoundary("application", "runtime", []);
  source.allowedPackages = ["@fixture/target"];
  const wrapper = localBoundary("target-wrapper", "runtime", []);
  const development = localBoundary("target-development", "development", []);
  assert.deepEqual(ruleIds(workspacePackageDiagnostics(source, [wrapper, development])), [
    "architecture.source-dependencies.runtime-boundary-imports-development-workspace-package",
  ]);
});

test("v2 mixed packages require exact runtime export-boundary authority", () => {
  const source = localBoundary("application", "runtime", []);
  source.allowedPackages = ["@fixture/target"];
  const runtime = localBoundary("target-runtime", "runtime", []);
  const development = localBoundary("target-development", "development", []);
  const rootRuntimeAuthority = new Map([
    ["@fixture/target", new Map([[".", runtime.id]])],
  ]);
  assert.deepEqual(
    v2WorkspacePackageDiagnostics(source, [runtime, development], {
      authority: rootRuntimeAuthority,
    }),
    [],
  );
  assert.deepEqual(ruleIds(v2WorkspacePackageDiagnostics(source, [runtime, development], {
    authority: new Map([["@fixture/target", new Map([[".", development.id]])]]),
  })), ["architecture.source-dependencies.runtime-boundary-imports-development-workspace-package"]);
  assert.deepEqual(ruleIds(v2WorkspacePackageDiagnostics(source, [runtime, development], {
    authority: rootRuntimeAuthority,
    subpath: "./qualification",
  })), ["architecture.source-dependencies.runtime-boundary-imports-development-workspace-package"]);
});

test("v2 admits only structured same-package development output candidates", () => {
  const sourceBoundary = boundary("development", []);
  const unresolved = {
    ...edge("../dist/index.js", "runtime"),
    specifier: "../dist/index.js",
    resolution: {
      kind: "generated-output-candidate",
      path: "packages/app/dist/index.js",
      workspacePackageName: "@fixture/app",
      workspacePackageManifestPath: "packages/app/package.json",
    },
  };
  const graph = {
    nodes: [],
    edges: [unresolved],
    parseFailures: [],
    unclassifiedSourcePaths: [],
    unresolvedRuntimeReferences: [],
  };
  assert.deepEqual(evaluateSourceDependencies({
    policy: {
      schemaVersion: 2,
      workspaceManifestPath: "pnpm-workspace.yaml",
      packageRoots: ["packages"],
      governedRoots: ["packages"],
      boundaries: [sourceBoundary],
    },
    graph,
  }), []);
  assert.deepEqual(ruleIds(evaluateSourceDependencies({
    policy: {
      schemaVersion: 2,
      workspaceManifestPath: "pnpm-workspace.yaml",
      packageRoots: ["packages"],
      governedRoots: ["packages"],
      boundaries: [{ ...sourceBoundary, dependencyMode: "runtime" }],
    },
    graph,
  })), ["architecture.source-dependencies.unresolved-local-import"]);
  assert.deepEqual(ruleIds(evaluateSourceDependencies({
    policy: {
      schemaVersion: 1,
      workspaceManifestPath: "pnpm-workspace.yaml",
      governedRoots: ["packages"],
      boundaries: [sourceBoundary],
    },
    graph,
  })), ["architecture.source-dependencies.unresolved-local-import"]);
});

test("generated output candidates require canonical same-package dist literals", async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), "foundation-generated-output-"));
  const workspacePackage = {
    name: "@fixture/app",
    rootPath: "packages/app",
    manifestPath: "packages/app/package.json",
    dependencies: [],
    bundledDependencies: [],
    exportSurface: { explicit: false, entries: [] },
  };
  const resolver = new NodeSourceDependencyResolver();
  const resolve = (specifier) => resolver.resolve({
    consumerRoot,
    file: {
      path: "packages/app/src/index.ts",
      workspacePackage,
      boundary: boundary("development", []),
      parsed: { parseErrorCount: 0, references: [], unresolved: [] },
      bytes: Buffer.from(""),
    },
    governedFilePaths: new Set(["packages/app/src/index.ts"]),
    inventory: { catalogs: [], packages: [workspacePackage] },
    reference: { kind: "static", specifier, start: 0, end: specifier.length },
  });
  try {
    assert.equal(resolve("../dist/index.js").kind, "generated-output-candidate");
    for (const specifier of [
      "../../private/dist/secret.js",
      "../../private/dist/../src/secret.js",
      "../dist/../src/secret.js",
      "../dist/%69ndex.js",
      "..\\dist\\index.js",
      "../dist//index.js",
      "../dist/./index.js",
      "../output/dist/index.js",
      "../dist/index.ts",
    ]) {
      assert.notEqual(resolve(specifier).kind, "generated-output-candidate", specifier);
    }
    await mkdir(join(consumerRoot, "packages", "app"), { recursive: true });
    await symlink(tmpdir(), join(consumerRoot, "packages", "app", "dist"), "dir");
    assert.notEqual(resolve("../dist/index.js").kind, "generated-output-candidate");
    await rm(join(consumerRoot, "packages", "app", "dist"));
    await mkdir(join(consumerRoot, "packages", "app", "dist"));
    await symlink(tmpdir(), join(consumerRoot, "packages", "app", "dist", "nested"), "dir");
    assert.notEqual(
      resolve("../dist/nested/index.js").kind,
      "generated-output-candidate",
    );
  } finally {
    await rm(consumerRoot, { recursive: true, force: true });
  }
});
