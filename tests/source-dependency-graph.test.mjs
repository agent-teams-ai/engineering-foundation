import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(repositoryRoot, "packages", "engineering-foundation");
const distRoot = process.env.ENGINEERING_FOUNDATION_DIST_ROOT ?? join(packageRoot, "dist");

async function loadDistModule(path) {
  return import(pathToFileURL(join(distRoot, path)).href);
}

const [
  { buildObservedSourceGraph },
  { analyzeSourceDependencies },
  { evaluateSourceDependencies },
  { evaluateSourceDependencyCycles },
  { NodeSourceDependencyResolver },
] = await Promise.all([
  loadDistModule(
    "capabilities/source-dependencies/application/use-cases/build-observed-source-graph.js",
  ),
  loadDistModule(
    "capabilities/source-dependencies/application/use-cases/analyze-source-dependencies.js",
  ),
  loadDistModule(
    "capabilities/source-dependencies/application/policies/evaluate-source-dependencies.js",
  ),
  loadDistModule(
    "capabilities/source-dependencies/application/policies/evaluate-source-dependency-cycles.js",
  ),
  loadDistModule(
    "capabilities/source-dependencies/adapters/outbound/node/node-source-dependency-resolver.js",
  ),
]);

function workspacePackage(name, rootPath, dependencies = []) {
  return Object.freeze({
    name,
    rootPath,
    manifestPath: `${rootPath}/package.json`,
    dependencies: Object.freeze(dependencies),
    bundledDependencies: Object.freeze([]),
    exportSurface: Object.freeze({
      explicit: true,
      entries: Object.freeze([{ subpath: ".", availability: "available" }]),
    }),
  });
}

function boundary(id, roots, options = {}) {
  return Object.freeze({
    id,
    dependencyMode: options.dependencyMode ?? "runtime",
    roots: Object.freeze(roots),
    entrypoints: Object.freeze(options.entrypoints ?? []),
    allowedBoundaries: Object.freeze(options.boundaries ?? []),
    allowedPackages: Object.freeze(options.packages ?? []),
    allowedBuiltins: Object.freeze(options.builtins ?? []),
    allowedRuntimeReferences: Object.freeze(options.runtimeReferences ?? []),
  });
}

function policy(boundaries) {
  return Object.freeze({
    schemaVersion: 1,
    workspaceManifestPath: "pnpm-workspace.yaml",
    governedRoots: Object.freeze(["packages"]),
    boundaries: Object.freeze(boundaries),
  });
}

function parsed(references = [], unresolved = []) {
  return Object.freeze({
    parseErrorCount: 0,
    references: Object.freeze(references),
    unresolved: Object.freeze(unresolved),
  });
}

function classified(path, sourceBoundary, sourcePackage, references = []) {
  return Object.freeze({
    path,
    source: "",
    boundary: sourceBoundary,
    workspacePackage: sourcePackage,
    parsed: parsed(references),
  });
}

function sourceFiles(classifiedFiles) {
  return classifiedFiles.map(({ path, source }) => ({ path, source }));
}

function sourceReference(kind, specifier, start) {
  return Object.freeze({ kind, specifier, start, end: start + specifier.length + 2 });
}

function byRule(diagnostics, ruleId) {
  return diagnostics.filter((diagnostic) => diagnostic.ruleId === ruleId);
}

function sourceAnalysisDependencies({ files, parsedSource, resolution, workspacePackage: packageValue }) {
  return Object.freeze({
    inventoryReader: Object.freeze({
      async read() {
        return Object.freeze({ packages: Object.freeze([packageValue]) });
      },
    }),
    parser: Object.freeze({
      parse() {
        return parsedSource;
      },
    }),
    resolver: Object.freeze({
      resolve() {
        return resolution;
      },
    }),
    sourceReader: Object.freeze({
      async read() {
        return files;
      },
    }),
  });
}

function evidence(diagnostic, kind) {
  const found = diagnostic.evidence.find((entry) => entry.kind === kind);
  assert.notEqual(found, undefined, `missing ${kind} evidence`);
  return found.value;
}

test("builds a deeply frozen, deterministic graph with POSIX Windows-path identity", () => {
  const appPackage = workspacePackage("@fixture/app", "packages/app");
  const application = boundary("app.application", ["packages/app/src/application"]);
  const domain = boundary("app.domain", ["packages/app/src/domain"]);
  const applicationFile = classified(
    "packages\\app\\src\\application\\execute.ts",
    application,
    appPackage,
    [sourceReference("static", "../domain/model.js", 9)],
  );
  const domainFile = classified(
    "packages\\app\\src\\domain\\model.ts",
    domain,
    appPackage,
  );
  const seenImporterPaths = [];
  const resolver = {
    resolve({ file }) {
      seenImporterPaths.push(file.path);
      return {
        kind: "local-file",
        path: "packages\\app\\src\\domain\\model.ts",
        workspacePackage: appPackage,
      };
    },
  };
  const input = {
    inventory: { packages: [appPackage] },
    allSourceFiles: sourceFiles([domainFile, applicationFile]),
    classifiedFiles: [domainFile, applicationFile],
    resolver,
  };
  const graph = buildObservedSourceGraph(input);
  const shuffled = buildObservedSourceGraph({
    ...input,
    allSourceFiles: input.allSourceFiles.toReversed(),
    classifiedFiles: input.classifiedFiles.toReversed(),
  });

  assert.deepEqual(graph, shuffled);
  assert.deepEqual(seenImporterPaths, [
    "packages/app/src/application/execute.ts",
    "packages/app/src/application/execute.ts",
  ]);
  assert.deepEqual(
    graph.nodes.map((node) => node.path),
    ["packages/app/src/application/execute.ts", "packages/app/src/domain/model.ts"],
  );
  assert.equal(graph.edges[0].resolution.path, "packages/app/src/domain/model.ts");
  assert.equal(Object.isFrozen(graph), true);
  assert.equal(Object.isFrozen(graph.nodes), true);
  assert.equal(Object.isFrozen(graph.nodes[0]), true);
  assert.equal(Object.isFrozen(graph.edges), true);
  assert.equal(Object.isFrozen(graph.edges[0]), true);
  assert.equal(Object.isFrozen(graph.edges[0].resolution), true);
  assert.throws(() => graph.nodes.push({}), TypeError);
});

test("schema v1 requires entrypoints and only permits declared cross-boundary targets", async () => {
  const schema = JSON.parse(
    await readFile(
      join(
        packageRoot,
        "schemas",
        "architecture-source-dependencies",
        "v1.schema.json",
      ),
      "utf8",
    ),
  );
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const validConfig = {
    schemaVersion: 1,
    workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
    governedRoots: ["packages/app/src"],
    boundaries: [
      {
        id: "app.domain",
        roots: ["packages/app/src/domain"],
        entrypoints: [],
        allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] },
      },
    ],
  };
  assert.equal(validate(validConfig), true, JSON.stringify(validate.errors));
  const missingEntrypoints = structuredClone(validConfig);
  delete missingEntrypoints.boundaries[0].entrypoints;
  assert.equal(validate(missingEntrypoints), false);

  const appPackage = workspacePackage("@fixture/app", "packages/app");
  const application = boundary("app.application", ["packages/app/src/application"], {
    boundaries: ["app.domain"],
    entrypoints: ["packages/app/src/application/execute.ts"],
  });
  const domain = boundary("app.domain", ["packages/app/src/domain"], {
    entrypoints: ["packages/app/src/domain/public.ts"],
  });
  const applicationFile = classified(
    "packages/app/src/application/execute.ts",
    application,
    appPackage,
    [
      sourceReference("static", "../domain/internal.js", 0),
      sourceReference("static", "../domain/public.js", 60),
    ],
  );
  const internalFile = classified(
    "packages/app/src/domain/internal.ts",
    domain,
    appPackage,
  );
  const publicFile = classified(
    "packages/app/src/domain/public.ts",
    domain,
    appPackage,
  );
  const resolver = {
    resolve({ reference }) {
      return {
        kind: "local-file",
        path:
          reference.specifier === "../domain/internal.js"
            ? "packages/app/src/domain/internal.ts"
            : "packages/app/src/domain/public.ts",
        workspacePackage: appPackage,
      };
    },
  };
  const graph = buildObservedSourceGraph({
    inventory: { packages: [appPackage] },
    allSourceFiles: sourceFiles([applicationFile, internalFile, publicFile]),
    classifiedFiles: [applicationFile, internalFile, publicFile],
    resolver,
  });
  const diagnostics = evaluateSourceDependencies({
    policy: policy([application, domain]),
    graph,
  });
  const entrypointViolations = byRule(
    diagnostics,
    "architecture.source-dependencies.cross-boundary-local-import-not-entrypoint",
  );
  assert.equal(entrypointViolations.length, 1);
  assert.equal(
    evidence(entrypointViolations[0], "target-path"),
    "packages/app/src/domain/internal.ts",
  );

  const staleDomain = boundary("app.domain", ["packages/app/src/domain"], {
    entrypoints: [
      "packages/app/src/domain/public.ts",
      "packages/app/src/domain/deleted.ts",
    ],
  });
  const staleEntrypointDiagnostics = evaluateSourceDependencies({
    policy: policy([application, staleDomain]),
    graph,
  });
  assert.equal(
    byRule(
      staleEntrypointDiagnostics,
      "architecture.source-dependencies.invalid-boundary-entrypoint",
    ).length,
    1,
  );
});

test("blocks package-name imports back into the importing workspace package", () => {
  const appPackage = workspacePackage("@fixture/app", "packages/app");
  const appBoundary = boundary("app.domain", ["packages/app/src"]);
  const appFile = classified(
    "packages/app/src/value.ts",
    appBoundary,
    appPackage,
    [sourceReference("static", "@fixture/app", 0)],
  );
  const graph = buildObservedSourceGraph({
    inventory: { packages: [appPackage] },
    allSourceFiles: sourceFiles([appFile]),
    classifiedFiles: [appFile],
    resolver: new NodeSourceDependencyResolver(),
  });
  assert.equal(graph.edges[0].resolution.kind, "self-workspace-package");
  const diagnostics = evaluateSourceDependencies({
    policy: policy([appBoundary]),
    graph,
  });
  assert.equal(
    byRule(
      diagnostics,
      "architecture.source-dependencies.self-package-import-boundary-unresolved",
    ).length,
    1,
  );
});

test("permits type-only imports from development dependencies but blocks runtime imports", () => {
  const appPackage = workspacePackage("@fixture/app", "packages/app", [
    {
      dependencyName: "fixture-types",
      section: "devDependencies",
      specifier: "1.0.0",
      targetPackageName: "fixture-types",
      effectiveSpecifier: "1.0.0",
      effectiveVersionSpecifier: "1.0.0",
      provenance: { kind: "manifest" },
    },
  ]);
  const appBoundary = boundary("app.application", ["packages/app/src"], {
    packages: ["fixture-types"],
  });
  const appFile = classified(
    "packages/app/src/index.ts",
    appBoundary,
    appPackage,
    [
      sourceReference("static-type", "fixture-types", 0),
      sourceReference("static", "fixture-types", 30),
    ],
  );
  const graph = buildObservedSourceGraph({
    inventory: { packages: [appPackage] },
    allSourceFiles: sourceFiles([appFile]),
    classifiedFiles: [appFile],
    resolver: new NodeSourceDependencyResolver(),
  });
  assert.deepEqual(
    graph.edges.map((edge) => edge.mode).toSorted(),
    ["runtime", "type-only"],
  );

  const diagnostics = evaluateSourceDependencies({
    policy: policy([appBoundary]),
    graph,
  });
  const developmentOnly = byRule(
    diagnostics,
    "architecture.source-dependencies.runtime-import-from-development-dependency",
  );
  assert.equal(developmentOnly.length, 1);
  assert.equal(developmentOnly[0].evidence[0].value, "fixture-types");
});

test("classifies a multi-root boundary from only roots that match the file", async () => {
  const appPackage = workspacePackage("@fixture/app", "packages/app");
  const broadBoundary = boundary("app.surface", [
    "packages/app/src",
    "packages/unrelated/deeply/nested/nonmatching",
  ]);
  const specificBoundary = boundary("app.feature", ["packages/app/src/feature"], {
    builtins: ["node:path"],
  });
  const files = Object.freeze([
    Object.freeze({
      path: "packages/app/src/feature/handler.ts",
      source: 'import { join } from "node:path";\nvoid join;\n',
    }),
  ]);

  const diagnostics = await analyzeSourceDependencies(
    {
      consumerRoot: ".",
      policy: policy([broadBoundary, specificBoundary]),
    },
    sourceAnalysisDependencies({
      files,
      parsedSource: parsed([sourceReference("static", "node:path", 0)]),
      resolution: Object.freeze({ kind: "builtin", specifier: "node:path" }),
      workspacePackage: appPackage,
    }),
  );

  assert.deepEqual(diagnostics, []);
});

test("rejects an ambiguous boundary classification tie", async () => {
  const appPackage = workspacePackage("@fixture/app", "packages/app");
  const alpha = boundary("app.alpha", ["packages/app/src"], {
    builtins: ["node:path"],
  });
  const zulu = boundary("app.zulu", ["packages/app/src"]);
  const files = Object.freeze([
    Object.freeze({
      path: "packages/app/src/handler.ts",
      source: 'import { join } from "node:path";\nvoid join;\n',
    }),
  ]);
  const dependencies = sourceAnalysisDependencies({
    files,
    parsedSource: parsed([sourceReference("static", "node:path", 0)]),
    resolution: Object.freeze({ kind: "builtin", specifier: "node:path" }),
    workspacePackage: appPackage,
  });

  await assert.rejects(
    () =>
      analyzeSourceDependencies(
        {
          consumerRoot: ".",
          policy: policy([zulu, alpha]),
        },
        dependencies,
      ),
    (error) => error?.problem?.code === "SOURCE_BOUNDARY_AMBIGUOUS",
  );
});

test("rejects runtime and type-only cycles between approved boundaries", () => {
  const appPackage = workspacePackage("@fixture/app", "packages/app");
  const a = boundary("app.a", ["packages/app/src/a"], {
    boundaries: ["app.b"],
    entrypoints: ["packages/app/src/a/index.ts"],
  });
  const b = boundary("app.b", ["packages/app/src/b"], {
    boundaries: ["app.a"],
    entrypoints: ["packages/app/src/b/index.ts"],
  });
  const aFile = classified(
    "packages/app/src/a/index.ts",
    a,
    appPackage,
    [
      sourceReference("static", "../b/index.js", 0),
      sourceReference("static-type", "../b/index.js", 30),
    ],
  );
  const bFile = classified(
    "packages/app/src/b/index.ts",
    b,
    appPackage,
    [
      sourceReference("static", "../a/index.js", 0),
      sourceReference("static-type", "../a/index.js", 30),
    ],
  );
  const graph = buildObservedSourceGraph({
    inventory: { packages: [appPackage] },
    allSourceFiles: sourceFiles([aFile, bFile]),
    classifiedFiles: [aFile, bFile],
    resolver: {
      resolve({ reference }) {
        return {
          kind: "local-file",
          path:
            reference.specifier === "../b/index.js"
              ? "packages/app/src/b/index.ts"
              : "packages/app/src/a/index.ts",
          workspacePackage: appPackage,
        };
      },
    },
  });

  const diagnostics = evaluateSourceDependencies({
    policy: policy([a, b]),
    graph,
  });
  assert.deepEqual(
    diagnostics
      .filter((diagnostic) => diagnostic.ruleId.includes("-cycle"))
      .map((diagnostic) => diagnostic.ruleId)
      .toSorted(),
    [
      "architecture.source-dependencies.boundary-runtime-cycle",
      "architecture.source-dependencies.boundary-type-only-cycle",
    ],
  );
  assert.equal(
    byRule(
      diagnostics,
      "architecture.source-dependencies.cross-boundary-local-import-not-entrypoint",
    ).length,
    0,
  );
});

test("classifies a mixed runtime and type-only SCC as a runtime cycle", () => {
  const appPackage = workspacePackage("@fixture/app", "packages/app");
  const a = boundary("app.a", ["packages/app/src/a"]);
  const b = boundary("app.b", ["packages/app/src/b"]);
  const aFile = classified(
    "packages/app/src/a/index.ts",
    a,
    appPackage,
    [sourceReference("static", "../b/index.js", 0)],
  );
  const bFile = classified(
    "packages/app/src/b/index.ts",
    b,
    appPackage,
    [sourceReference("static-type", "../a/index.js", 0)],
  );
  const graph = buildObservedSourceGraph({
    inventory: { packages: [appPackage] },
    allSourceFiles: sourceFiles([aFile, bFile]),
    classifiedFiles: [aFile, bFile],
    resolver: {
      resolve({ reference }) {
        return {
          kind: "local-file",
          path:
            reference.specifier === "../b/index.js"
              ? "packages/app/src/b/index.ts"
              : "packages/app/src/a/index.ts",
          workspacePackage: appPackage,
        };
      },
    },
  });

  assert.deepEqual(
    evaluateSourceDependencyCycles(graph).map((diagnostic) => diagnostic.ruleId),
    ["architecture.source-dependencies.boundary-runtime-cycle"],
  );
});

test("reports separate deterministic boundary and package SCCs with canonical bounded witnesses", () => {
  const localPackage = workspacePackage("@fixture/local", "packages/local");
  const packageOne = workspacePackage(
    "@fixture/one",
    "packages/one",
    [{ dependencyName: "@fixture/two", section: "dependencies" }],
  );
  const packageTwo = workspacePackage(
    "@fixture/two",
    "packages/two",
    [{ dependencyName: "@fixture/one", section: "dependencies" }],
  );
  const a = boundary("local.a", ["packages/local/src/a"], {
    boundaries: ["local.b"],
    entrypoints: ["packages/local/src/a/a.ts"],
  });
  const b = boundary("local.b", ["packages/local/src/b"], {
    boundaries: ["local.a", "local.c"],
    entrypoints: ["packages/local/src/b/b.ts"],
  });
  const c = boundary("local.c", ["packages/local/src/c"], {
    boundaries: ["local.a"],
    entrypoints: ["packages/local/src/c/c.ts"],
  });
  const one = boundary("one.surface", ["packages/one/src"], {
    packages: ["@fixture/two"],
    entrypoints: ["packages/one/src/index.ts"],
  });
  const two = boundary("two.surface", ["packages/two/src"], {
    packages: ["@fixture/one"],
    entrypoints: ["packages/two/src/index.ts"],
  });
  const aFile = classified(
    "packages/local/src/a/a.ts",
    a,
    localPackage,
    [
      sourceReference("static", "../b/b.js", 0),
      sourceReference("static-type", "../b/b.js", 30),
    ],
  );
  const bFile = classified(
    "packages/local/src/b/b.ts",
    b,
    localPackage,
    [
      sourceReference("static", "../c/c.js", 0),
      sourceReference("static-type", "../a/a.js", 30),
    ],
  );
  const cFile = classified(
    "packages/local/src/c/c.ts",
    c,
    localPackage,
    [sourceReference("static", "../a/a.js", 0)],
  );
  const oneFile = classified(
    "packages/one/src/index.ts",
    one,
    packageOne,
    [
      sourceReference("static", "@fixture/two", 0),
      sourceReference("static-type", "@fixture/two", 30),
    ],
  );
  const twoFile = classified(
    "packages/two/src/index.ts",
    two,
    packageTwo,
    [
      sourceReference("static", "@fixture/one", 0),
      sourceReference("static-type", "@fixture/one", 30),
    ],
  );
  const sourcePathBySpecifier = Object.freeze({
    "../b/b.js": "packages/local/src/b/b.ts",
    "../c/c.js": "packages/local/src/c/c.ts",
    "../a/a.js": "packages/local/src/a/a.ts",
  });
  const resolver = {
    resolve({ reference }) {
      const sourcePath = sourcePathBySpecifier[reference.specifier];
      if (sourcePath !== undefined) {
        return { kind: "local-file", path: sourcePath, workspacePackage: localPackage };
      }
      if (reference.specifier === "@fixture/one") {
        return {
          kind: "workspace-package",
          workspacePackage: packageOne,
          declaration: "runtime",
          exported: true,
          subpath: ".",
        };
      }
      return {
        kind: "workspace-package",
        workspacePackage: packageTwo,
        declaration: "runtime",
        exported: true,
        subpath: ".",
      };
    },
  };
  const files = [aFile, bFile, cFile, oneFile, twoFile];
  const input = {
    inventory: { packages: [localPackage, packageOne, packageTwo] },
    allSourceFiles: sourceFiles(files),
    classifiedFiles: files,
    resolver,
  };
  const graph = buildObservedSourceGraph(input);
  const shuffledGraph = buildObservedSourceGraph({
    ...input,
    allSourceFiles: input.allSourceFiles.toReversed(),
    classifiedFiles: input.classifiedFiles.toReversed(),
  });
  assert.deepEqual(graph, shuffledGraph);

  const diagnostics = evaluateSourceDependencies({
    policy: policy([a, b, c, one, two]),
    graph,
  });
  const cycleRules = diagnostics
    .filter((diagnostic) => diagnostic.ruleId.includes("-cycle"))
    .map((diagnostic) => diagnostic.ruleId)
    .toSorted();
  assert.deepEqual(cycleRules, [
    "architecture.source-dependencies.boundary-runtime-cycle",
    "architecture.source-dependencies.boundary-type-only-cycle",
    "architecture.source-dependencies.package-runtime-cycle",
    "architecture.source-dependencies.package-type-only-cycle",
  ]);
  const runtimeBoundary = byRule(
    diagnostics,
    "architecture.source-dependencies.boundary-runtime-cycle",
  )[0];
  assert.equal(evidence(runtimeBoundary, "cycle-witness"), "local.a -> local.b -> local.c -> local.a");
  const typeBoundary = byRule(
    diagnostics,
    "architecture.source-dependencies.boundary-type-only-cycle",
  )[0];
  assert.equal(evidence(typeBoundary, "cycle-witness"), "local.a -> local.b -> local.a");
  const runtimePackage = byRule(
    diagnostics,
    "architecture.source-dependencies.package-runtime-cycle",
  )[0];
  assert.equal(
    evidence(runtimePackage, "cycle-witness"),
    "@fixture/one -> @fixture/two -> @fixture/one",
  );
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.ruleId.includes("file-runtime-cycle")),
    false,
  );
});

test("bounds a canonical SCC witness without recursive traversal", () => {
  const members = Array.from(
    { length: 2_048 },
    (_, index) => `boundary.${String(index).padStart(2, "0")}`,
  );
  const graph = Object.freeze({
    nodes: Object.freeze([]),
    edges: Object.freeze(
      members.map((fromBoundaryId, index) => {
        const toBoundaryId = members[(index + 1) % members.length];
        return Object.freeze({
          fromPath: `packages/app/src/${index}.ts`,
          fromBoundaryId,
          fromWorkspacePackageName: "@fixture/app",
          fromWorkspacePackageManifestPath: "packages/app/package.json",
          kind: "static",
          mode: "runtime",
          specifier: `./${(index + 1) % members.length}.js`,
          start: 0,
          end: 1,
          resolution: Object.freeze({
            kind: "local-file",
            path: `packages/app/src/${(index + 1) % members.length}.ts`,
            workspacePackageName: "@fixture/app",
            workspacePackageManifestPath: "packages/app/package.json",
            targetBoundaryId: toBoundaryId,
          }),
        });
      }),
    ),
    parseFailures: Object.freeze([]),
    unclassifiedSourcePaths: Object.freeze([]),
    unresolvedRuntimeReferences: Object.freeze([]),
  });
  const [diagnostic] = evaluateSourceDependencyCycles(graph);
  assert.equal(
    diagnostic.ruleId,
    "architecture.source-dependencies.boundary-runtime-cycle",
  );
  assert.match(evidence(diagnostic, "cycle-witness"), /boundary\.00 -> boundary\.01 -> .*\.\.\..* -> boundary\.00/);
  assert.equal(evidence(diagnostic, "cycle-witness-edge-count"), "2048");
});

test("caller-owned source snapshots reject concrete adapter edges including type-only imports", async () => {
  const { OxcSourceDependencyParser } = await loadDistModule(
    "capabilities/source-dependencies/adapters/outbound/oxc/oxc-source-dependency-parser.js",
  );
  const pkg = workspacePackage("@fixture/app", "packages/app");
  const consumer = boundary("consumer.application", ["packages/app/src/consumer"], {
    boundaries: ["observation.application"],
  });
  const application = boundary("observation.application", ["packages/app/src/observation/application"], {
    entrypoints: ["packages/app/src/observation/application/api.ts"],
  });
  const adapter = boundary("observation.adapter", ["packages/app/src/observation/adapters"], {
    entrypoints: ["packages/app/src/observation/adapters/filesystem.ts"],
  });
  for (const [statement, rejected] of [
    ['import type { Snapshot } from "../observation/application/api.js";', false],
    ['import { read } from "../observation/application/api.js";', false],
    ['import { FilesystemReader } from "../observation/adapters/filesystem.js";', true],
    ['import type { FilesystemReader } from "../observation/adapters/filesystem.js";', true],
    ['export type { FilesystemReader } from "../observation/adapters/filesystem.js";', true],
  ]) {
    const files = [
      { path: "packages/app/src/consumer/use-case.ts", source: statement },
      { path: "packages/app/src/observation/application/api.ts", source: "export interface Snapshot { path: string }; export function read() { return []; }" },
      { path: "packages/app/src/observation/adapters/filesystem.ts", source: "export class FilesystemReader { read() { return []; } }" },
    ];
    const signal = new AbortController().signal;
    let reads = 0;
    const diagnostics = await analyzeSourceDependencies({
      consumerRoot: "/no-filesystem-authority", policy: policy([consumer, application, adapter]), signal,
    }, {
      inventoryReader: { async read() { return { packages: [pkg] }; } },
      sourceReader: { async read(root, roots, observedSignal) {
        reads += 1;
        assert.equal(root, "/no-filesystem-authority");
        assert.deepEqual(roots, ["packages"]);
        assert.equal(observedSignal, signal);
        return files;
      } },
      parser: new OxcSourceDependencyParser(),
      resolver: new NodeSourceDependencyResolver(),
    });
    assert.equal(reads, 1);
    assert.deepEqual(diagnostics.map(({ ruleId }) => ruleId), rejected
      ? ["architecture.source-dependencies.forbidden-boundary-dependency"] : [], statement);
  }
});
