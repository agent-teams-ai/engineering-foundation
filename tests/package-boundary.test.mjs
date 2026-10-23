import {
  dependencySections,
  escapedRegex,
  fencedCodeBlocks,
  registerRepositoryBoundaryGuidanceTests,
} from "./package-boundary-guidance-cases.ts";
import {
  registerAdapterBoundaryTests,
  registerQgrBoundaryTests,
} from "./package-boundary-adapter-cases.ts";
import { normalizeDependencyDeclaration } from "../packages/engineering-foundation/dist/workspace-inventory/application/policies/normalize-dependency-declaration.js";
import { sourceDependencyAdapters } from "./support/capability-adapters.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { createSourceDependenciesCapability } from "../packages/engineering-foundation/dist/capabilities/source-dependencies/module.js";
import {
  importedSpecifiers,
  object,
  packageName,
  pathsContaining,
  sourceFiles,
} from "./package-boundary-support.mjs";

import { PUBLISHABLE_PACKAGES } from "../scripts/publishable-packages.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const repositoryMutationName = "@agent-teams/repository-mutation",
  documentAuthoringName = "@agent-teams/document-authoring";
const foundationName = "@agent-teams/engineering-foundation",
  docsProtocolAgentTeamsName = "@agent-teams/docs-protocol-agent-teams";
const openSourceDocsRelease = JSON.parse(
  await readFile(
    join(repositoryRoot, "architecture/foundation/open-source-docs-release.json"),
    "utf8",
  ),
);
const docsProtocolName = openSourceDocsRelease.packages.cli.name;
const docsProtocolMcpName = openSourceDocsRelease.packages.mcp.name;
const exactVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

async function json(path) {
  return JSON.parse(await readFile(join(repositoryRoot, path), "utf8"));
}

test("open-source install authority is exact, registry-pinned, atomic, and DRY", async () => {
  const canonical = await readFile(
    join(repositoryRoot, "docs/reference/open-source-docs-protocol.md"),
    "utf8",
  );
  assert.deepEqual(Object.keys(openSourceDocsRelease).toSorted(), [
    "packages",
    "qualifiedPackageManagers",
    "registry",
    "schemaVersion",
    "source",
  ]);
  assert.equal(openSourceDocsRelease.schemaVersion, 1);
  assert.deepEqual(openSourceDocsRelease.qualifiedPackageManagers, ["npm", "pnpm"]);
  assert.deepEqual(openSourceDocsRelease.source, {
    ref: "refs/heads/main",
    repository: "https://github.com/agent-teams-ai/engineering-foundation",
    workflow: ".github/workflows/release.yml",
  });
  const docsCoordinate = `${docsProtocolName}@${openSourceDocsRelease.packages.cli.version}`;
  const mcpCoordinate = `${docsProtocolMcpName}@${openSourceDocsRelease.packages.mcp.version}`;
  assert.doesNotMatch(canonical, /X\.Y\.Z|docs-protocol@0\.3\.2/u);
  const executableExamples = fencedCodeBlocks(canonical);
  assert.doesNotMatch(
    executableExamples.join("\n"),
    /(?:\bnpx\b|\bpnpm\s+dlx\b|@agent-teams\/docs-protocol(?:-mcp)?@latest|X\.Y\.Z)/u,
  );
  for (const example of executableExamples.filter((block) =>
    /(?:npm|pnpm)\s+(?:view|install|add)[\s\S]*@agent-teams\/docs-protocol/u.test(block),
  )) {
    assert.match(example, new RegExp(escapedRegex(openSourceDocsRelease.registry), "u"));
    if (example.includes(docsProtocolMcpName)) {
      assert.match(example, new RegExp(escapedRegex(mcpCoordinate), "u"));
    }
    if (example.replaceAll(docsProtocolMcpName, "").includes(docsProtocolName)) {
      assert.match(example, new RegExp(escapedRegex(docsCoordinate), "u"));
    }
  }
  for (const expected of [
    docsCoordinate,
    mcpCoordinate,
    `--registry=${openSourceDocsRelease.registry}`,
    `--@agent-teams:registry=${openSourceDocsRelease.registry}`,
    `--config.registry=${openSourceDocsRelease.registry}`,
    `--config.@agent-teams:registry=${openSourceDocsRelease.registry}`,
  ]) {
    assert.match(canonical, new RegExp(escapedRegex(expected), "u"));
  }
  assert.match(
    canonical,
    new RegExp(
      `npm install[\\s\\S]*?${escapedRegex(docsCoordinate)}[\\s\\S]*?${escapedRegex(mcpCoordinate)}`,
      "u",
    ),
  );
  assert.match(
    canonical,
    new RegExp(
      `pnpm add[\\s\\S]*?${escapedRegex(docsCoordinate)}[\\s\\S]*?${escapedRegex(mcpCoordinate)}`,
      "u",
    ),
  );

  const readmes = await Promise.all(
    ["README.md", "packages/docs-protocol/README.md", "packages/docs-protocol-mcp/README.md"].map(
      async (path) => ({ path, source: await readFile(join(repositoryRoot, path), "utf8") }),
    ),
  );
  for (const { path, source } of readmes) {
    assert.match(
      source,
      /open-source-docs-protocol\.md/u,
      `${path} must route to canonical install authority`,
    );
    assert.doesNotMatch(
      source,
      new RegExp(
        `(?:npm\\s+(?:install|view)|pnpm\\s+(?:add|view|dlx)|npx)[\\s\\S]{0,500}` +
          `${escapedRegex(docsProtocolName)}|${escapedRegex(docsCoordinate)}|${escapedRegex(mcpCoordinate)}`,
        "u",
      ),
      path,
    );
  }
});

function reverseDependencyReferences(foundation, workspace = {}) {
  const direct = dependencySections.flatMap((section) =>
    Object.hasOwn(object(foundation[section]), docsProtocolName)
      ? [`${section}.${docsProtocolName}`]
      : [],
  );
  const foundationPnpm = ["overrides", "dependenciesMeta", "packageExtensions"].flatMap((section) =>
    pathsContaining(object(foundation.pnpm)[section], [docsProtocolName], ["pnpm", section]),
  );
  const workspacePnpm = ["overrides", "packageExtensions"].flatMap((section) =>
    pathsContaining(
      object(workspace.pnpm)[section],
      [foundationName, docsProtocolName],
      ["pnpm", section],
    ),
  );
  return [...direct, ...foundationPnpm, ...workspacePnpm].toSorted();
}

test("publishable package catalog and manifests preserve one-way layering", async () => {
  assert.deepEqual(
    PUBLISHABLE_PACKAGES.map((releasePackage) => releasePackage.name),
    [
      "@agent-teams/ci-input-proof",
      "@agent-teams/release-checks",
      repositoryMutationName,
      documentAuthoringName,
      docsProtocolName,
      docsProtocolAgentTeamsName,
      docsProtocolMcpName,
      foundationName,
      "@agent-teams/feature-module-standard",
      "stack-toolchain",
    ],
  );
  const repositoryMutation = await json("packages/repository-mutation/package.json");
  const documentAuthoring = await json("packages/document-authoring/package.json");
  const foundation = await json("packages/engineering-foundation/package.json");
  const docsProtocol = await json("packages/docs-protocol/package.json");
  const docsProtocolAgentTeams = await json("packages/docs-protocol-agent-teams/package.json");
  const docsProtocolMcp = await json("packages/docs-protocol-mcp/package.json");
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
  for (const section of dependencySections) {
    assert.equal(
      repositoryMutation[section]?.[foundationName],
      undefined,
      `Repository Mutation cannot depend on Foundation through ${section}`,
    );
  }
  assert.equal(foundation.dependencies?.[repositoryMutationName], "workspace:*");
  assert.equal(foundation.dependencies?.[documentAuthoringName], "workspace:*");
  assert.equal(docsProtocol.dependencies?.[repositoryMutationName], "workspace:*");
  assert.equal(docsProtocol.dependencies?.[documentAuthoringName], "workspace:*");
  assert.equal(docsProtocol.dependencies?.[foundationName], undefined);
  assert.equal(docsProtocol.dependencies?.[docsProtocolAgentTeamsName], undefined);
  assert.equal(docsProtocol.dependencies?.[docsProtocolMcpName], undefined);
  assert.equal(docsProtocolAgentTeams.dependencies?.[docsProtocolName], "workspace:*");
  assert.equal(docsProtocolAgentTeams.dependencies?.[foundationName], undefined);
  assert.equal(docsProtocolAgentTeams.dependencies?.[documentAuthoringName], undefined);
  assert.equal(docsProtocolAgentTeams.dependencies?.[repositoryMutationName], "workspace:*");
  for (const manifest of [repositoryMutation, documentAuthoring, foundation, docsProtocol]) {
    for (const section of dependencySections) {
      assert.equal(
        manifest[section]?.[docsProtocolAgentTeamsName],
        undefined,
        `${manifest.name} cannot create a reverse dependency on the Agent Teams adapter`,
      );
    }
  }
  assert.equal(docsProtocolMcp.dependencies?.[docsProtocolName], "workspace:*");
  assert.equal(docsProtocolMcp.dependencies?.[foundationName], undefined);
  assert.match(
    docsProtocolMcp.version,
    exactVersion,
    "Docs Protocol MCP must retain an exact semver version after its initial Changesets release",
  );
  assert.equal(docsProtocolMcp.private, undefined);
  assert.deepEqual(docsProtocolMcp.publishConfig, {
    access: "public",
    provenance: true,
    registry: "https://registry.npmjs.org/",
  });
  assert.match(foundation.version, exactVersion);
  for (const section of dependencySections) {
    assert.equal(
      foundation[section]?.[foundationName],
      undefined,
      `published Foundation cannot depend on itself through ${section}`,
    );
  }
  assert.equal(
    docsProtocol.dependencies[documentAuthoringName] === "workspace:*"
      ? documentAuthoring.version
      : docsProtocol.dependencies[documentAuthoringName],
    documentAuthoring.version,
    "Docs Protocol must pack its one-way Document Authoring dependency to the exact version",
  );
  assert.equal(
    docsProtocolMcp.dependencies[docsProtocolName] === "workspace:*"
      ? docsProtocol.version
      : docsProtocolMcp.dependencies[docsProtocolName],
    docsProtocol.version,
    "Docs Protocol MCP must pack its one-way Docs Protocol dependency to the exact version",
  );
  const packageDirectories = await readdir(join(repositoryRoot, "packages"), {
    withFileTypes: true,
  });
  for (const entry of packageDirectories.filter((candidate) => candidate.isDirectory())) {
    const manifest = await json(`packages/${entry.name}/package.json`);
    if (manifest.name !== foundationName) {
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
  assert.equal(
    workspace.scripts["foundation:bootstrap"],
    "node tools/repository-command.mts script build",
  );
  assert.equal(
    workspace.scripts["foundation:dogfood"],
    "node tools/repository-command.mts script foundation:bootstrap && node tools/repository-command.mts script foundation:check:built",
  );
  assert.equal(
    workspace.scripts["foundation:qualification"],
    "node tools/repository-command.mts script foundation:dogfood && node tools/repository-command.mts script package:check:built && node tools/repository-command.mts script registry-install-e2e:built && node tools/repository-command.mts script published-compatibility:e2e",
  );
  assert.equal(
    workspace.scripts["foundation:check"],
    "node tools/repository-command.mts script foundation:dogfood",
  );
  assert.equal(
    workspace.scripts["foundation:check:built"],
    "node tools/repository-command.mts tool foundation:check:built",
  );
  assert.doesNotMatch(
    workspace.scripts["foundation:check:built"],
    /(?:pnpm|npmjs\.org|published)/u,
    "current-source dogfood must retain the freshly built CLI inside its private native migration driver",
  );
});

test("reverse dependency guard rejects alternate manifest and pnpm injection paths", () => {
  const directCases = dependencySections.map((section) => ({
    [section]: { [docsProtocolName]: "1.0.0" },
  }));
  const pnpmCases = [
    { pnpm: { overrides: { [docsProtocolName]: "1.0.0" } } },
    { pnpm: { dependenciesMeta: { [docsProtocolName]: { injected: true } } } },
    {
      pnpm: {
        packageExtensions: {
          [`${foundationName}@*`]: { dependencies: { [docsProtocolName]: "1.0.0" } },
        },
      },
    },
  ];
  for (const manifest of [...directCases, ...pnpmCases]) {
    assert.notDeepEqual(reverseDependencyReferences(manifest), [], JSON.stringify(manifest));
  }
  const workspaceCases = [
    { pnpm: { overrides: { [`${foundationName}>${docsProtocolName}`]: "1.0.0" } } },
    {
      pnpm: {
        packageExtensions: {
          [`${foundationName}@*`]: { optionalDependencies: { [docsProtocolName]: "1.0.0" } },
        },
      },
    },
  ];
  for (const workspace of workspaceCases) {
    assert.notDeepEqual(reverseDependencyReferences({}, workspace), [], JSON.stringify(workspace));
  }
  assert.deepEqual(
    reverseDependencyReferences({}, { pnpm: { overrides: { [docsProtocolName]: "1.0.0" } } }),
    [],
  );
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
    assert.ok(!boundary.allow.packages.includes(docsProtocolAgentTeamsName), boundary.id);
  }
  const foundationLocalMode = policy.boundaries.find(({ id }) => id === "foundation.local-mode");
  const localModeApplication = policy.boundaries.find(
    ({ id }) => id === "foundation.local-mode.application",
  );
  const localModeAdapters = policy.boundaries.find(
    ({ id }) => id === "foundation.local-mode.adapters",
  );
  assert.deepEqual(foundationLocalMode.allow.builtins, []);
  assert.deepEqual(localModeApplication.allow.builtins, []);
  assert.deepEqual(localModeAdapters.allow.builtins, [
    "node:fs/promises",
    "node:module",
    "node:path",
    "node:url",
    "node:util",
  ]);
  const repositoryMutationBoundaries = policy.boundaries.filter((boundary) =>
    boundary.roots.some((root) => root.startsWith("packages/repository-mutation/")),
  );
  assert.ok(repositoryMutationBoundaries.length > 0);
  for (const boundary of repositoryMutationBoundaries) {
    assert.ok(!boundary.allow.packages.includes(foundationName), boundary.id);
  }
  const docsBoundaries = policy.boundaries.filter((boundary) =>
    boundary.roots.some((root) => root.startsWith("packages/docs-protocol/src/")),
  );
  const docsSources = await sourceFiles(join(repositoryRoot, "packages/docs-protocol/src"));
  const specifiers = (await Promise.all(docsSources.map((path) => readFile(path, "utf8")))).flatMap(
    importedSpecifiers,
  );
  const observedBuiltins = [
    ...new Set(specifiers.filter((specifier) => specifier.startsWith("node:"))),
  ].toSorted();
  const observedPackages = [...new Set(specifiers.map(packageName).filter(Boolean))].toSorted();
  const allowedBuiltins = [
    ...new Set(docsBoundaries.flatMap((boundary) => boundary.allow.builtins)),
  ].toSorted();
  const allowedPackages = [
    ...new Set(docsBoundaries.flatMap((boundary) => boundary.allow.packages)),
  ].toSorted();
  assert.deepEqual(allowedBuiltins, observedBuiltins);
  assert.deepEqual(allowedPackages, observedPackages);
  const docsManifest = await json("packages/docs-protocol/package.json");
  assert.deepEqual(Object.keys(docsManifest.dependencies).toSorted(), observedPackages);
});

test("Docs Protocol retains its golden clean-layer dependency fence", async () => {
  const policy = parseYaml(
    await readFile(
      join(repositoryRoot, "architecture/foundation/source-dependencies.yaml"),
      "utf8",
    ),
  );
  const boundaries = Object.fromEntries(
    policy.boundaries
      .filter(({ roots }) =>
        roots.some(
          (root) =>
            root === "packages/docs-protocol/src" || root.startsWith("packages/docs-protocol/src/"),
        ),
      )
      .map(({ id, roots, allow, entrypoints }) => [
        id,
        {
          roots,
          boundaries: allow.boundaries,
          packages: allow.packages,
          builtins: allow.builtins,
          entrypoints,
        },
      ]),
  );
  const expected = JSON.parse(
    await readFile(new URL("./fixtures/docs-protocol-boundaries.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(boundaries, expected);
});

test("Docs Protocol MCP retains six governed read-only feature boundaries", async () => {
  const mcp = "packages/docs-protocol-mcp/src",
    feature = `${mcp}/read-only-docs`;
  const policy = parseYaml(
    await readFile(
      join(repositoryRoot, "architecture/foundation/source-dependencies.yaml"),
      "utf8",
    ),
  );
  // Select by source ownership so unexpected boundaries cannot escape the snapshot.
  const boundaries = policy.boundaries.filter(({ roots }) =>
    roots.some((root) => root === mcp || root.startsWith(`${mcp}/`)),
  );
  const emptyAllow = { boundaries: [], packages: [], builtins: [], runtimeReferences: [] };
  assert.deepEqual(boundaries, [
    {
      id: "docs-protocol-mcp.application",
      roots: [`${feature}/application`],
      allow: { ...emptyAllow, packages: [docsProtocolName] },
      entrypoints: [`${feature}/application/ports/docs-reader.ts`],
    },
    {
      id: "docs-protocol-mcp.package-identity",
      roots: [`${feature}/adapters/outbound/installed-package-version.ts`],
      allow: { ...emptyAllow, builtins: ["node:fs"] },
      entrypoints: [`${feature}/adapters/outbound/installed-package-version.ts`],
    },
    {
      id: "docs-protocol-mcp.reader",
      roots: [`${feature}/adapters/outbound/node-docs-reader.ts`],
      allow: {
        ...emptyAllow,
        boundaries: ["docs-protocol-mcp.application"],
        packages: [docsProtocolName],
      },
      entrypoints: [`${feature}/adapters/outbound/node-docs-reader.ts`],
    },
    {
      id: "docs-protocol-mcp.transport",
      roots: [`${feature}/adapters/inbound`],
      allow: {
        ...emptyAllow,
        boundaries: ["docs-protocol-mcp.application", "docs-protocol-mcp.package-identity"],
        packages: [docsProtocolName, "@modelcontextprotocol/server"],
        builtins: ["node:fs/promises", "node:path"],
      },
      entrypoints: [
        `${feature}/adapters/inbound/cli-input.ts`,
        `${feature}/adapters/inbound/server.ts`,
        `${feature}/adapters/inbound/tools.ts`,
        `${feature}/adapters/inbound/tool-contracts.ts`,
        `${feature}/adapters/inbound/output-schemas.ts`,
      ],
    },
    {
      id: "docs-protocol-mcp.composition",
      roots: [`${feature}/composition`, `${feature}/module.ts`],
      allow: {
        ...emptyAllow,
        boundaries: [
          "docs-protocol-mcp.application",
          "docs-protocol-mcp.transport",
          "docs-protocol-mcp.reader",
          "docs-protocol-mcp.package-identity",
        ],
        packages: ["@modelcontextprotocol/server"],
      },
      entrypoints: [`${feature}/module.ts`],
    },
    {
      id: "docs-protocol-mcp.surface",
      packageExports: ["."],
      roots: [`${mcp}/index.ts`, `${mcp}/cli.ts`],
      allow: { ...emptyAllow, boundaries: ["docs-protocol-mcp.composition"] },
      entrypoints: [`${mcp}/index.ts`, `${mcp}/cli.ts`],
    },
  ]);
  const sources = await sourceFiles(join(repositoryRoot, mcp));
  const specifiers = (await Promise.all(sources.map((path) => readFile(path, "utf8")))).flatMap(
    importedSpecifiers,
  );
  assert.deepEqual(
    [...new Set(specifiers.filter((specifier) => specifier.startsWith("node:")))].toSorted(),
    [...new Set(boundaries.flatMap((boundary) => boundary.allow.builtins))].toSorted(),
  );
  assert.deepEqual(
    [...new Set(specifiers.map(packageName).filter(Boolean))].toSorted(),
    [...new Set(boundaries.flatMap((boundary) => boundary.allow.packages))].toSorted(),
  );
});

test("Docs Protocol clean-layer policy rejects outward imports and permits composition wiring", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "docs-protocol-layer-boundary-"));
  try {
    const policy = parseYaml(
      await readFile(
        join(repositoryRoot, "architecture/foundation/source-dependencies.yaml"),
        "utf8",
      ),
    );
    const layerIds = new Set([
      "docs-protocol.portable-documentation.adapters",
      "docs-protocol.portable-documentation.application",
      "docs-protocol.portable-documentation.composition",
      "docs-protocol.portable-documentation.domain",
    ]);
    const layers = ["domain", "application", "adapters", "composition"];
    const fixturePolicy = {
      schemaVersion: 2,
      workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
      packageRoots: ["packages"],
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
      ...layers.map((layer) =>
        mkdir(join(temporaryRoot, `packages/docs-protocol/src/${layer}`), { recursive: true }),
      ),
    ]);
    await Promise.all([
      writeFile(
        join(temporaryRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "@fixture/repository",
            version: "0.0.0",
            private: true,
            type: "module",
            packageManager: "pnpm@11.20.0",
          },
          null,
          2,
        )}\n`,
      ),
      writeFile(join(temporaryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n"),
      writeFile(
        join(temporaryRoot, "packages/docs-protocol/package.json"),
        `${JSON.stringify(
          {
            name: docsProtocolName,
            version: "0.0.0",
            private: true,
            type: "module",
            exports: { ".": "./src/composition/index.ts" },
          },
          null,
          2,
        )}\n`,
      ),
      writeFile(
        join(temporaryRoot, "architecture/foundation/source-dependencies.yaml"),
        stringifyYaml(fixturePolicy, { lineWidth: 0 }),
      ),
      ...layers.map((layer) =>
        writeFile(
          join(temporaryRoot, `packages/docs-protocol/src/${layer}/index.ts`),
          "export const marker = true;\n",
        ),
      ),
    ]);

    const forbiddenCases = [
      ["domain", "application"],
      ["application", "adapters"],
      ["adapters", "composition"],
    ];
    for (const [sourceLayer, targetLayer] of forbiddenCases) {
      const sourcePath = join(temporaryRoot, `packages/docs-protocol/src/${sourceLayer}/index.ts`);
      await writeFile(
        sourcePath,
        `import { marker } from "../${targetLayer}/index.js";\nexport const probe = marker;\n`,
      );
      const rejected = await createSourceDependenciesCapability(sourceDependencyAdapters()).run({
        consumerRoot: temporaryRoot,
        configPath: "architecture/foundation/source-dependencies.yaml",
      });
      assert.equal(rejected.outcome, "violations", `${sourceLayer} -> ${targetLayer}`);
      assert.ok(
        rejected.diagnostics.some(
          ({ location, ruleId }) =>
            ruleId === "architecture.source-dependencies.forbidden-boundary-dependency" &&
            location.path.endsWith(`${sourceLayer}/index.ts`),
        ),
        `${sourceLayer} -> ${targetLayer}`,
      );
      await writeFile(sourcePath, "export const marker = true;\n");
    }

    await writeFile(
      join(temporaryRoot, "packages/docs-protocol/src/composition/index.ts"),
      'import { marker } from "../adapters/index.js";\nexport const probe = marker;\n',
    );
    const accepted = await createSourceDependenciesCapability(sourceDependencyAdapters()).run({
      consumerRoot: temporaryRoot,
      configPath: "architecture/foundation/source-dependencies.yaml",
    });
    assert.equal(accepted.outcome, "passed", JSON.stringify(accepted, null, 2));
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

registerAdapterBoundaryTests();
registerQgrBoundaryTests();

registerRepositoryBoundaryGuidanceTests();

test("document authoring public surface exposes no directory rollback capability", async () => {
  const runtime = await import("../packages/document-authoring/dist/index.js");
  assert.deepEqual(
    Object.keys(runtime).filter((name) => /rollback/iu.test(name)),
    [],
  );
  const declarations = await readFile(
    join(repositoryRoot, "packages/document-authoring/dist/index.d.ts"),
    "utf8",
  );
  assert.doesNotMatch(declarations, /DocumentParentRollbackResultV2|directory-removed/iu);
  const authoringSources = await sourceFiles(
    join(repositoryRoot, "packages/document-authoring/src"),
  );
  for (const path of authoringSources) {
    assert.doesNotMatch(
      await readFile(path, "utf8"),
      /DocumentParentRollbackResultV2|directory-removed/iu,
      path,
    );
  }
});

function assertToolchainLinterOwnership(manifest, ownerManifest, catalogs = []) {
  const bundling = [manifest.bundledDependencies, manifest.bundleDependencies];
  const bundled = bundling.some((value) => value === true)
    ? true
    : bundling.flatMap((value) => value ?? []);
  for (const tool of ["oxlint", "oxlint-tsgolint"]) {
    assert.ok(
      bundled !== true || !Object.keys(manifest.dependencies ?? {}).includes(tool),
      `${manifest.name} cannot bundle ${tool}`,
    );
    assert.ok(
      bundled === true || !bundled.includes(tool),
      `${manifest.name} cannot bundle ${tool}`,
    );
  }
  for (const section of dependencySections) {
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      const declaration = normalizeDependencyDeclaration({
        catalogs,
        dependencyName: name,
        specifier,
        section,
        packageName: manifest.name,
        manifestPath: "package.json",
      });
      const protectedName = ["oxlint", "oxlint-tsgolint"].find(
        (tool) => tool === name || tool === declaration.targetPackageName,
      );
      if (protectedName === undefined) {
        continue;
      }
      assert.ok(
        bundled !== true && !bundled.includes(name) && !bundled.includes(protectedName),
        `${manifest.name} cannot bundle ${protectedName}`,
      );
      if (section === "devDependencies") {
        continue;
      }
      assert.equal(
        manifest.name,
        ownerManifest.name,
        `${manifest.name} cannot declare runtime ${protectedName}`,
      );
      assert.equal(
        section,
        "dependencies",
        `${protectedName} belongs in its owner's required dependencies`,
      );
      assert.equal(name, protectedName, "Toolchain runtime tools use canonical names");
      assert.equal(specifier, ownerManifest.dependencies[protectedName]);
    }
  }
}

test("only Stack Toolchain owns runtime linter dependencies across all workspaces", async () => {
  const owner = await json("packages/stack-toolchain/package.json");
  assert.equal(owner.name, "stack-toolchain");
  for (const name of ["oxlint", "oxlint-tsgolint"]) {
    assert.equal(owner.dependencies[name], "catalog:");
  }
  const rootManifest = await json("package.json");
  const workspace = parseYaml(await readFile(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8"));
  assert.deepEqual(
    workspace.packages,
    ["packages/*", "spikes/*"],
    "Update the owner-policy inventory before adding workspace patterns",
  );
  const catalogs = Object.entries(workspace.catalog).map(([dependencyName, version]) => ({
    catalogName: "default",
    dependencyName,
    version,
  }));
  for (const [catalogName, entries] of Object.entries(workspace.catalogs ?? {})) {
    for (const [dependencyName, version] of Object.entries(entries)) {
      catalogs.push({ catalogName, dependencyName, version });
    }
  }
  const manifests = [rootManifest];
  for (const parent of ["packages", "spikes"]) {
    for (const entry of await readdir(join(repositoryRoot, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const source = await readFile(
        join(repositoryRoot, parent, entry.name, "package.json"),
        "utf8",
      ).catch((error) => {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      });
      if (source !== null) {
        manifests.push(JSON.parse(source));
      }
    }
  }
  for (const manifest of manifests) {
    assertToolchainLinterOwnership(manifest, owner, catalogs);
  }
  for (const name of ["oxlint", "oxlint-tsgolint"]) {
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      assert.throws(
        () =>
          assertToolchainLinterOwnership(
            { name: "unrelated-consumer", [section]: { [name]: owner.dependencies[name] } },
            owner,
          ),
        /cannot declare runtime/u,
      );
    }
  }
});

test("runtime linter ownership rejects npm and catalog aliases and all bundling", () => {
  const owner = {
    name: "stack-toolchain",
    dependencies: { oxlint: "catalog:", "oxlint-tsgolint": "catalog:" },
  };
  for (const tool of Object.keys(owner.dependencies)) {
    const catalogs = [
      { catalogName: "default", dependencyName: "alias", version: `npm:${tool}@1.0.0` },
    ];
    for (const specifier of [`npm:${tool}@1.0.0`, "catalog:"]) {
      assert.throws(
        () =>
          assertToolchainLinterOwnership(
            { name: "other", dependencies: { alias: specifier } },
            owner,
            catalogs,
          ),
        /cannot declare runtime/u,
      );
    }
    for (const field of ["bundleDependencies", "bundledDependencies"]) {
      for (const name of ["other", owner.name]) {
        assert.throws(
          () =>
            assertToolchainLinterOwnership(
              { name, devDependencies: { [tool]: "catalog:" }, [field]: [tool] },
              owner,
            ),
          /cannot bundle/u,
        );
      }
    }
  }
});
