import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { createSourceDependenciesCapability } from "../packages/engineering-foundation/dist/capabilities/source-dependencies/module.js";
import { PUBLISHABLE_PACKAGES } from "../scripts/publishable-packages.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const foundationName = "@agent-teams/engineering-foundation";
const docsProtocolName = "@agent-teams/docs-protocol";
const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

async function json(path) {
  return JSON.parse(await readFile(join(repositoryRoot, path), "utf8"));
}

async function sourceFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function importedSpecifiers(source) {
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*)["']([^"']+)["']/gu)].map((match) => match[1]);
}

function packageName(specifier) {
  if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/")) {return;}
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function pathsContaining(value, packageNames, path = []) {
  if (typeof value === "string") {
    const evidence = [...path, value].join(" ");
    return packageNames.every((name) => evidence.includes(name)) ? [path.join(".")] : [];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {return [];}
  return Object.entries(value).flatMap(([key, entry]) => {
    const next = [...path, key];
    const evidence = next.join(" ");
    const here = packageNames.every((name) => evidence.includes(name)) ? [next.join(".")] : [];
    return [...here, ...pathsContaining(entry, packageNames, next)];
  });
}

function reverseDependencyReferences(foundation, workspace = {}) {
  const direct = dependencySections.flatMap((section) =>
    Object.hasOwn(object(foundation[section]), docsProtocolName) ? [`${section}.${docsProtocolName}`] : []);
  const foundationPnpm = ["overrides", "dependenciesMeta", "packageExtensions"].flatMap((section) =>
    pathsContaining(object(foundation.pnpm)[section], [docsProtocolName], ["pnpm", section]));
  const workspacePnpm = ["overrides", "packageExtensions"].flatMap((section) =>
    pathsContaining(object(workspace.pnpm)[section], [foundationName, docsProtocolName], ["pnpm", section]));
  return [...direct, ...foundationPnpm, ...workspacePnpm].toSorted();
}

test("publishable package catalog and manifests preserve one-way layering", async () => {
  assert.deepEqual(
    PUBLISHABLE_PACKAGES.map((releasePackage) => releasePackage.name),
    [foundationName, docsProtocolName],
  );
  const foundation = await json("packages/engineering-foundation/package.json");
  const docsProtocol = await json("packages/docs-protocol/package.json");
  const workspace = await json("package.json");
  assert.equal(docsProtocol.private, undefined);
  assert.deepEqual(docsProtocol.publishConfig, {
    access: "public",
    provenance: true,
    registry: "https://registry.npmjs.org/",
  });
  assert.match(
    docsProtocol.version,
    exactVersion,
    "Docs Protocol must retain an exact semver version after Changesets promotes the bootstrap manifest",
  );
  assert.deepEqual(reverseDependencyReferences(foundation, workspace), []);
  assert.equal(docsProtocol.dependencies?.[foundationName], "workspace:*");
  assert.match(foundation.version, exactVersion);
  for (const section of dependencySections) {
    assert.equal(
      foundation[section]?.[foundationName],
      undefined,
      `published Foundation cannot depend on itself through ${section}`,
    );
  }
  assert.equal(workspace.devDependencies?.[foundationName], "workspace:*");
  assert.equal(
    docsProtocol.dependencies[foundationName] === "workspace:*" ? foundation.version : docsProtocol.dependencies[foundationName],
    foundation.version,
    "Docs Protocol must pack its one-way Foundation dependency to the exact Foundation version",
  );
  const packageDirectories = await readdir(join(repositoryRoot, "packages"), {
    withFileTypes: true,
  });
  for (const entry of packageDirectories.filter((candidate) => candidate.isDirectory())) {
    const manifest = await json(`packages/${entry.name}/package.json`);
    if (manifest.name !== docsProtocolName) {
      assert.equal(
        manifest.dependencies?.[foundationName],
        undefined,
        `${manifest.name} cannot use Foundation as a runtime dependency`,
      );
    }
  }
});

test("Foundation self-dogfood lifecycle is build-gated and source-owned", async () => {
  const workspace = await json("package.json");
  assert.equal(workspace.scripts["foundation:bootstrap"], "pnpm build");
  assert.equal(
    workspace.scripts["foundation:dogfood"],
    "pnpm foundation:bootstrap && pnpm foundation:check:built",
  );
  assert.equal(
    workspace.scripts["foundation:qualification"],
    "pnpm foundation:dogfood && pnpm package:check:built && pnpm registry-install-e2e:built && pnpm published-compatibility:e2e",
  );
  assert.equal(workspace.scripts["foundation:check"], "pnpm foundation:dogfood");
  assert.equal(
    workspace.scripts["foundation:check:built"],
    "node packages/engineering-foundation/dist/cli.js check --consumer .",
  );
  assert.doesNotMatch(
    workspace.scripts["foundation:check:built"],
    /(?:pnpm|npmjs\.org|published)/u,
    "current-source dogfood must execute the freshly built CLI directly",
  );
});

test("reverse dependency guard rejects alternate manifest and pnpm injection paths", () => {
  const directCases = dependencySections.map((section) => ({ [section]: { [docsProtocolName]: "1.0.0" } }));
  const pnpmCases = [
    { pnpm: { overrides: { [docsProtocolName]: "1.0.0" } } },
    { pnpm: { dependenciesMeta: { [docsProtocolName]: { injected: true } } } },
    { pnpm: { packageExtensions: { [`${foundationName}@*`]: { dependencies: { [docsProtocolName]: "1.0.0" } } } } }
  ];
  for (const manifest of [...directCases, ...pnpmCases]) {
    assert.notDeepEqual(reverseDependencyReferences(manifest), [], JSON.stringify(manifest));
  }
  const workspaceCases = [
    { pnpm: { overrides: { [`${foundationName}>${docsProtocolName}`]: "1.0.0" } } },
    { pnpm: { packageExtensions: { [`${foundationName}@*`]: { optionalDependencies: { [docsProtocolName]: "1.0.0" } } } } }
  ];
  for (const workspace of workspaceCases) {
    assert.notDeepEqual(reverseDependencyReferences({}, workspace), [], JSON.stringify(workspace));
  }
  assert.deepEqual(reverseDependencyReferences({}, { pnpm: { overrides: { [docsProtocolName]: "1.0.0" } } }), []);
});

test("Foundation source and source-boundary authority cannot import Docs Protocol", async () => {
  const foundationSources = await sourceFiles(
    join(repositoryRoot, "packages", "engineering-foundation", "src"),
  );
  for (const path of foundationSources) {
    assert.doesNotMatch(await readFile(path, "utf8"), /@agent-teams\/docs-protocol/u, path);
  }
  const policy = parseYaml(
    await readFile(
      join(repositoryRoot, "architecture", "foundation", "source-dependencies.yaml"),
      "utf8",
    ),
  );
  const foundationBoundaries = policy.boundaries.filter((boundary) =>
    boundary.roots.some((root) => root.startsWith("packages/engineering-foundation/")),
  );
  assert.ok(foundationBoundaries.length > 0);
  for (const boundary of foundationBoundaries) {
    assert.ok(!boundary.allow.packages.includes(docsProtocolName), boundary.id);
  }
  const docsBoundaries = policy.boundaries.filter((boundary) =>
    boundary.roots.some((root) => root.startsWith("packages/docs-protocol/")),
  );
  const docsSources = await sourceFiles(join(repositoryRoot, "packages/docs-protocol/src"));
  const specifiers = (await Promise.all(docsSources.map((path) => readFile(path, "utf8"))))
    .flatMap(importedSpecifiers);
  const observedBuiltins = [...new Set(specifiers.filter((specifier) => specifier.startsWith("node:")))].toSorted();
  const observedPackages = [...new Set(specifiers.map(packageName).filter(Boolean))].toSorted();
  const allowedBuiltins = [...new Set(docsBoundaries.flatMap((boundary) =>
    boundary.allow.builtins))].toSorted();
  const allowedPackages = [...new Set(docsBoundaries.flatMap((boundary) =>
    boundary.allow.packages))].toSorted();
  assert.deepEqual(allowedBuiltins, observedBuiltins);
  assert.deepEqual(allowedPackages, observedPackages);
  const docsManifest = await json("packages/docs-protocol/package.json");
  assert.deepEqual(Object.keys(docsManifest.dependencies).toSorted(), observedPackages);
});

test("Docs Protocol retains its golden clean-layer dependency fence", async () => {
  const policy = parseYaml(await readFile(join(
    repositoryRoot,
    "architecture/foundation/source-dependencies.yaml",
  ), "utf8"));
  const boundaries = Object.fromEntries(policy.boundaries
    .filter(({ id }) => [
      "docs-protocol.adapters",
      "docs-protocol.application",
      "docs-protocol.composition",
      "docs-protocol.domain",
      "docs-protocol.qualification",
    ].includes(id))
    .map(({ id, roots, allow, entrypoints }) => [id, {
      roots,
      boundaries: allow.boundaries,
      packages: allow.packages,
      builtins: allow.builtins,
      entrypoints,
    }]));
  assert.deepEqual(boundaries, {
    "docs-protocol.domain": {
      roots: ["packages/docs-protocol/src/domain"],
      boundaries: [],
      packages: [foundationName],
      builtins: ["node:path"],
      entrypoints: [
        "packages/docs-protocol/src/domain/document-semantics.ts",
        "packages/docs-protocol/src/domain/model.ts",
        "packages/docs-protocol/src/domain/profile-policy.ts",
      ],
    },
    "docs-protocol.application": {
      roots: ["packages/docs-protocol/src/application"],
      boundaries: ["docs-protocol.domain"],
      packages: [foundationName, "yaml"],
      builtins: [],
      entrypoints: ["packages/docs-protocol/src/application/docs-protocol.ts"],
    },
    "docs-protocol.adapters": {
      roots: ["packages/docs-protocol/src/adapters"],
      boundaries: ["docs-protocol.application", "docs-protocol.domain"],
      packages: [foundationName, "ajv", "ajv-formats", "yaml"],
      builtins: ["node:fs", "node:fs/promises", "node:module", "node:path", "node:url"],
      entrypoints: [
        "packages/docs-protocol/src/adapters/docs-command-envelope-schema-validator.ts",
        "packages/docs-protocol/src/adapters/foundation-docs-port.ts",
        "packages/docs-protocol/src/adapters/node-adoption-inspector.ts",
        "packages/docs-protocol/src/adapters/node-code-anchor-matcher.ts",
        "packages/docs-protocol/src/adapters/node-profile-reader.ts",
      ],
    },
    "docs-protocol.composition": {
      roots: [
        "packages/docs-protocol/src/composition",
        "packages/docs-protocol/src/index.ts",
        "packages/docs-protocol/src/cli.ts",
      ],
      boundaries: [
        "docs-protocol.adapters",
        "docs-protocol.application",
        "docs-protocol.consumer-integration.composition",
        "docs-protocol.domain",
        "docs-protocol.qualification",
      ],
      packages: [foundationName],
      builtins: [],
      entrypoints: [
        "packages/docs-protocol/src/index.ts",
        "packages/docs-protocol/src/cli.ts",
      ],
    },
    "docs-protocol.qualification": {
      roots: ["packages/docs-protocol/src/qualification"],
      boundaries: [
        "docs-protocol.adapters",
        "docs-protocol.application",
        "docs-protocol.consumer-integration.adapters",
        "docs-protocol.consumer-integration.composition",
        "docs-protocol.consumer-integration.domain",
        "docs-protocol.domain",
      ],
      packages: [foundationName, "ajv"],
      builtins: [
        "node:child_process",
        "node:crypto",
        "node:fs",
        "node:fs/promises",
        "node:os",
        "node:path",
        "node:url",
      ],
      entrypoints: ["packages/docs-protocol/src/qualification/index.ts"],
    },
  });
});

test("Docs Protocol clean-layer policy rejects outward imports and permits composition wiring", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "docs-protocol-layer-boundary-"));
  try {
    const policy = parseYaml(await readFile(join(
      repositoryRoot,
      "architecture/foundation/source-dependencies.yaml",
    ), "utf8"));
    const layerIds = new Set([
      "docs-protocol.adapters",
      "docs-protocol.application",
      "docs-protocol.composition",
      "docs-protocol.domain",
    ]);
    const layers = ["domain", "application", "adapters", "composition"];
    const fixturePolicy = {
      schemaVersion: 1,
      workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
      governedRoots: ["packages/docs-protocol/src"],
      boundaries: policy.boundaries
        .filter(({ id }) => layerIds.has(id))
        .map((boundary) => ({
          ...boundary,
          roots: [`packages/docs-protocol/src/${boundary.id.split(".").at(-1)}`],
          allow: {
            ...boundary.allow,
            boundaries: boundary.allow.boundaries.filter((id) => layerIds.has(id)),
            packages: [],
            builtins: [],
          },
          entrypoints: [`packages/docs-protocol/src/${boundary.id.split(".").at(-1)}/index.ts`],
        })),
    };
    await Promise.all([
      mkdir(join(temporaryRoot, "architecture/foundation"), { recursive: true }),
      ...layers.map((layer) => mkdir(join(
        temporaryRoot,
        `packages/docs-protocol/src/${layer}`,
      ), { recursive: true })),
    ]);
    await Promise.all([
      writeFile(join(temporaryRoot, "package.json"), `${JSON.stringify({
        name: "@fixture/repository",
        version: "0.0.0",
        private: true,
        type: "module",
        packageManager: "pnpm@11.20.0",
      }, null, 2)}\n`),
      writeFile(join(temporaryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n"),
      writeFile(join(temporaryRoot, "packages/docs-protocol/package.json"), `${JSON.stringify({
        name: docsProtocolName,
        version: "0.0.0",
        private: true,
        type: "module",
      }, null, 2)}\n`),
      writeFile(
        join(temporaryRoot, "architecture/foundation/source-dependencies.yaml"),
        stringifyYaml(fixturePolicy, { lineWidth: 0 }),
      ),
      ...layers.map((layer) => writeFile(join(
        temporaryRoot,
        `packages/docs-protocol/src/${layer}/index.ts`,
      ), "export const marker = true;\n")),
    ]);

    const forbiddenCases = [
      ["domain", "application"],
      ["application", "adapters"],
      ["adapters", "composition"],
    ];
    for (const [sourceLayer, targetLayer] of forbiddenCases) {
      const sourcePath = join(
        temporaryRoot,
        `packages/docs-protocol/src/${sourceLayer}/index.ts`,
      );
      await writeFile(
        sourcePath,
        `import { marker } from "../${targetLayer}/index.js";\nexport const probe = marker;\n`,
      );
      const rejected = await createSourceDependenciesCapability().run({
        consumerRoot: temporaryRoot,
        configPath: "architecture/foundation/source-dependencies.yaml",
      });
      assert.equal(rejected.outcome, "violations", `${sourceLayer} -> ${targetLayer}`);
      assert.ok(rejected.diagnostics.some(({ location, ruleId }) =>
        ruleId === "architecture.source-dependencies.forbidden-boundary-dependency" &&
        location.path.endsWith(`${sourceLayer}/index.ts`)), `${sourceLayer} -> ${targetLayer}`);
      await writeFile(sourcePath, "export const marker = true;\n");
    }

    await writeFile(
      join(temporaryRoot, "packages/docs-protocol/src/composition/index.ts"),
      "import { marker } from \"../adapters/index.js\";\nexport const probe = marker;\n",
    );
    const accepted = await createSourceDependenciesCapability().run({
      consumerRoot: temporaryRoot,
      configPath: "architecture/foundation/source-dependencies.yaml",
    });
    assert.equal(accepted.outcome, "passed", JSON.stringify(accepted, null, 2));
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("Docs Protocol consumer integration retains its golden internal dependency fence", async () => {
  const policy = parseYaml(await readFile(join(
    repositoryRoot,
    "architecture/foundation/source-dependencies.yaml",
  ), "utf8"));
  const boundaries = Object.fromEntries(policy.boundaries
    .filter(({ id }) => id.startsWith("docs-protocol.consumer-integration."))
    .map(({ id, roots, allow, entrypoints }) => [id, {
      roots,
      boundaries: allow.boundaries,
      packages: allow.packages,
      builtins: allow.builtins,
      entrypoints,
    }]));
  assert.deepEqual(boundaries, {
    "docs-protocol.consumer-integration.domain": {
      roots: ["packages/docs-protocol/src/consumer-integration/domain"],
      boundaries: [], packages: [], builtins: [],
      entrypoints: ["packages/docs-protocol/src/consumer-integration/domain/model.ts"],
    },
    "docs-protocol.consumer-integration.generated-assets": {
      roots: ["packages/docs-protocol/src/consumer-integration/generated"],
      boundaries: [], packages: [], builtins: [],
      entrypoints: ["packages/docs-protocol/src/consumer-integration/generated/canonical-assets.ts"],
    },
    "docs-protocol.consumer-integration.application": {
      roots: ["packages/docs-protocol/src/consumer-integration/application"],
      boundaries: [
        "docs-protocol.consumer-integration.domain",
        "docs-protocol.consumer-integration.generated-assets",
      ],
      packages: [foundationName],
      builtins: ["node:crypto"],
      entrypoints: [
        "packages/docs-protocol/src/consumer-integration/application/model/consumer-integration-execution.ts",
        "packages/docs-protocol/src/consumer-integration/application/policies/consumer-integration-assets.ts",
        "packages/docs-protocol/src/consumer-integration/application/policies/consumer-integration-desired-state.ts",
        "packages/docs-protocol/src/consumer-integration/application/ports/consumer-integration-lifecycle.ts",
        "packages/docs-protocol/src/consumer-integration/application/ports/consumer-integration-planners.ts",
        "packages/docs-protocol/src/consumer-integration/application/use-cases/plan-consumer-integration.ts",
        "packages/docs-protocol/src/consumer-integration/application/use-cases/run-consumer-integration.ts",
      ],
    },
    "docs-protocol.consumer-integration.adapters": {
      roots: ["packages/docs-protocol/src/consumer-integration/adapters"],
      boundaries: [
        "docs-protocol.consumer-integration.application",
        "docs-protocol.consumer-integration.domain",
      ],
      packages: [foundationName, "ajv", "ajv-formats", "jsonc-parser", "yaml"],
      builtins: ["node:child_process", "node:crypto", "node:fs", "node:fs/promises", "node:path"],
      entrypoints: [
        "packages/docs-protocol/src/consumer-integration/adapters/agents-route-adapter-v1.ts",
        "packages/docs-protocol/src/consumer-integration/adapters/consumer-integration-schema-validator.ts",
        "packages/docs-protocol/src/consumer-integration/adapters/foundation-known-file-transaction.ts",
        "packages/docs-protocol/src/consumer-integration/adapters/node-consumer-integration-repository.ts",
        "packages/docs-protocol/src/consumer-integration/adapters/package-consumer-asset-catalog.ts",
        "packages/docs-protocol/src/consumer-integration/adapters/pnpm-manifest-adapter-v1.ts",
      ],
    },
    "docs-protocol.consumer-integration.composition": {
      roots: [
        "packages/docs-protocol/src/consumer-integration/composition",
        "packages/docs-protocol/src/consumer-integration/index.ts",
      ],
      boundaries: [
        "docs-protocol.consumer-integration.adapters",
        "docs-protocol.consumer-integration.application",
        "docs-protocol.consumer-integration.domain",
      ],
      packages: [], builtins: [],
      entrypoints: [
        "packages/docs-protocol/src/consumer-integration/composition/consumer-integration-cli.ts",
        "packages/docs-protocol/src/consumer-integration/index.ts",
      ],
    },
  });

  const applicationSources = await sourceFiles(join(
    repositoryRoot,
    "packages/docs-protocol/src/consumer-integration/application",
  ));
  for (const path of applicationSources) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /(?:^|\/)adapters(?:\/|$)/u, path);
    assert.doesNotMatch(source, /node:(?:child_process|fs|module|os|path|url)/u, path);
  }
});

test("Docs Protocol boundary policy classifies new application files and rejects adapter imports", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "docs-consumer-boundary-"));
  try {
    const policy = parseYaml(await readFile(join(
      repositoryRoot,
      "architecture/foundation/source-dependencies.yaml",
    ), "utf8"));
    const relevantBoundaryIds = new Set([
      "docs-protocol.consumer-integration.adapters",
      "docs-protocol.consumer-integration.application",
      "docs-protocol.consumer-integration.domain",
      "docs-protocol.consumer-integration.generated-assets",
    ]);
    const fixturePolicy = {
      schemaVersion: 1,
      workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
      governedRoots: ["packages/docs-protocol/src/consumer-integration"],
      boundaries: policy.boundaries
        .filter(({ id }) => relevantBoundaryIds.has(id))
        .map((boundary) => ({
          ...boundary,
          entrypoints: boundary.id.endsWith(".adapters")
            ? ["packages/docs-protocol/src/consumer-integration/adapters/node-consumer-integration-repository.ts"]
            : boundary.id.endsWith(".domain")
              ? ["packages/docs-protocol/src/consumer-integration/domain/model.ts"]
              : [],
        })),
    };
    const paths = {
      application: join(
        temporaryRoot,
        "packages/docs-protocol/src/consumer-integration/application/use-cases/new-use-case.ts",
      ),
      adapter: join(
        temporaryRoot,
        "packages/docs-protocol/src/consumer-integration/adapters/node-consumer-integration-repository.ts",
      ),
      domain: join(
        temporaryRoot,
        "packages/docs-protocol/src/consumer-integration/domain/model.ts",
      ),
      generated: join(
        temporaryRoot,
        "packages/docs-protocol/src/consumer-integration/generated",
      ),
    };
    await Promise.all([
      mkdir(join(temporaryRoot, "architecture/foundation"), { recursive: true }),
      mkdir(dirname(paths.application), { recursive: true }),
      mkdir(dirname(paths.adapter), { recursive: true }),
      mkdir(dirname(paths.domain), { recursive: true }),
      mkdir(paths.generated, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(temporaryRoot, "package.json"), `${JSON.stringify({
        name: "@fixture/repository",
        version: "0.0.0",
        private: true,
        type: "module",
        packageManager: "pnpm@11.20.0",
      }, null, 2)}\n`),
      writeFile(join(temporaryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n"),
      writeFile(join(temporaryRoot, "packages/docs-protocol/package.json"), `${JSON.stringify({
        name: docsProtocolName,
        version: "0.0.0",
        private: true,
        type: "module",
      }, null, 2)}\n`),
      writeFile(
        join(temporaryRoot, "architecture/foundation/source-dependencies.yaml"),
        stringifyYaml(fixturePolicy, { lineWidth: 0 }),
      ),
      writeFile(paths.adapter, "export const nodeAdapter = true;\n"),
      writeFile(paths.domain, "export interface DomainMarker { readonly id: string; }\n"),
      writeFile(
        paths.application,
        "import { nodeAdapter } from \"../../adapters/node-consumer-integration-repository.js\";\nexport const execute = nodeAdapter;\n",
      ),
    ]);

    const rejected = await createSourceDependenciesCapability().run({
      consumerRoot: temporaryRoot,
      configPath: "architecture/foundation/source-dependencies.yaml",
    });
    assert.equal(rejected.outcome, "violations");
    assert.ok(rejected.diagnostics.some(({ location, ruleId }) =>
      ruleId === "architecture.source-dependencies.forbidden-boundary-dependency" &&
      location.path.endsWith("application/use-cases/new-use-case.ts")));

    await writeFile(
      paths.application,
      "import type { DomainMarker } from \"../../domain/model.js\";\nexport type UseCaseMarker = DomainMarker;\n",
    );
    const accepted = await createSourceDependenciesCapability().run({
      consumerRoot: temporaryRoot,
      configPath: "architecture/foundation/source-dependencies.yaml",
    });
    assert.equal(accepted.outcome, "passed", JSON.stringify(accepted, null, 2));
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("source dependency capability accepts the exact repository allowlist", async () => {
  const report = await createSourceDependenciesCapability().run({
    consumerRoot: repositoryRoot,
    configPath: "architecture/foundation/source-dependencies.yaml",
  });
  assert.equal(report.outcome, "passed", JSON.stringify(report, null, 2));
});

test("current authoring guidance uses only the unified explicit-mutation CLI", async () => {
  for (const path of [
    "README.md",
    "docs/architecture/document-authoring-protocol.md",
    "packages/engineering-foundation/README.md",
  ]) {
    const source = await readFile(join(repositoryRoot, path), "utf8");
    assert.doesNotMatch(source, /agent-teams-foundation docs/u, path);
    assert.doesNotMatch(source, /without `--dry-run`/u, path);
    assert.match(source, /agent-teams-docs/u, path);
  }
});

test("document authoring public surface exposes no directory rollback capability", async () => {
  const runtime = await import(
    "../packages/engineering-foundation/dist/document-authoring/index.js"
  );
  assert.deepEqual(
    Object.keys(runtime).filter((name) => /rollback/iu.test(name)),
    [],
  );
  const declarations = await readFile(join(
    repositoryRoot,
    "packages/engineering-foundation/dist/document-authoring/index.d.ts",
  ), "utf8");
  assert.doesNotMatch(
    declarations,
    /DocumentParentRollbackResultV2|directory-removed/iu,
  );
  const authoringSources = await sourceFiles(join(
    repositoryRoot,
    "packages/engineering-foundation/src/document-authoring",
  ));
  for (const path of authoringSources) {
    assert.doesNotMatch(
      await readFile(path, "utf8"),
      /DocumentParentRollbackResultV2|directory-removed/iu,
      path,
    );
  }
});

test("production and generic directory adapters share the internal bind kernel", async () => {
  const production = await readFile(join(
    repositoryRoot,
    "packages/engineering-foundation/src/document-authoring/adapters/node/node-document-parent-materializer.ts",
  ), "utf8");
  const generic = await readFile(join(
    repositoryRoot,
    "packages/engineering-foundation/src/repository-mutation/adapters/node/node-directory-materialization.ts",
  ), "utf8");
  for (const source of [production, generic]) {
    assert.match(source, /node-create-and-bind-directory\.js/iu);
    assert.match(source, /createAndBindNodeDirectory\s*\(/u);
  }
  const publicMutationBarrel = await readFile(join(
    repositoryRoot,
    "packages/engineering-foundation/src/mutation/index.ts",
  ), "utf8");
  assert.doesNotMatch(publicMutationBarrel, /createAndBindNodeDirectory/u);
});
