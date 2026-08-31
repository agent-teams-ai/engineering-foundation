import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { createSourceDependenciesCapability } from "../packages/engineering-foundation/dist/capabilities/source-dependencies/module.js";
import { PUBLISHABLE_PACKAGES } from "../scripts/publishable-packages.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const repositoryMutationName = "@agent-teams/repository-mutation";
const foundationName = "@agent-teams/engineering-foundation";
const docsProtocolAgentTeamsName = "@agent-teams/docs-protocol-agent-teams";
const openSourceDocsRelease = JSON.parse(await readFile(
  join(repositoryRoot, "architecture/foundation/open-source-docs-release.json"),
  "utf8",
));
const docsProtocolName = openSourceDocsRelease.packages.cli.name;
const docsProtocolMcpName = openSourceDocsRelease.packages.mcp.name;
const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

async function json(path) {
  return JSON.parse(await readFile(join(repositoryRoot, path), "utf8"));
}

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function fencedCodeBlocks(source) {
  return [...source.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)].map((match) => match[1]);
}

test("open-source install authority is exact, registry-pinned, atomic, and DRY", async () => {
  const canonical = await readFile(
    join(repositoryRoot, "docs/reference/open-source-docs-protocol.md"),
    "utf8",
  );
  assert.deepEqual(Object.keys(openSourceDocsRelease).toSorted(), [
    "packages", "qualifiedPackageManagers", "registry", "schemaVersion", "source",
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
    /(?:npm|pnpm)\s+(?:view|install|add)[\s\S]*@agent-teams\/docs-protocol/u.test(block))) {
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
    new RegExp(`npm install[\\s\\S]*?${escapedRegex(docsCoordinate)}[\\s\\S]*?${escapedRegex(mcpCoordinate)}`, "u"),
  );
  assert.match(
    canonical,
    new RegExp(`pnpm add[\\s\\S]*?${escapedRegex(docsCoordinate)}[\\s\\S]*?${escapedRegex(mcpCoordinate)}`, "u"),
  );

  const readmes = await Promise.all([
    "README.md",
    "packages/docs-protocol/README.md",
    "packages/docs-protocol-mcp/README.md",
  ].map(async (path) => ({ path, source: await readFile(join(repositoryRoot, path), "utf8") })));
  for (const { path, source } of readmes) {
    assert.match(source, /open-source-docs-protocol\.md/u, `${path} must route to canonical install authority`);
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
    [
      repositoryMutationName,
      foundationName,
      docsProtocolName,
      docsProtocolAgentTeamsName,
      docsProtocolMcpName,
    ],
  );
  const repositoryMutation = await json("packages/repository-mutation/package.json");
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
  assert.equal(docsProtocol.dependencies?.[repositoryMutationName], "workspace:*");
  assert.equal(docsProtocol.dependencies?.[foundationName], "workspace:*");
  assert.equal(docsProtocol.dependencies?.[docsProtocolAgentTeamsName], undefined);
  assert.equal(docsProtocol.dependencies?.[docsProtocolMcpName], undefined);
  assert.equal(docsProtocolAgentTeams.dependencies?.[docsProtocolName], "workspace:*");
  assert.equal(docsProtocolAgentTeams.dependencies?.[foundationName], "workspace:*");
  assert.equal(docsProtocolAgentTeams.dependencies?.[repositoryMutationName], "workspace:*");
  for (const manifest of [repositoryMutation, foundation, docsProtocol]) {
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
  assert.equal(workspace.devDependencies?.[foundationName], "workspace:*");
  assert.equal(
    docsProtocol.dependencies[foundationName] === "workspace:*" ? foundation.version : docsProtocol.dependencies[foundationName],
    foundation.version,
    "Docs Protocol must pack its one-way Foundation dependency to the exact Foundation version",
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
    if (![docsProtocolName, docsProtocolAgentTeamsName].includes(manifest.name)) {
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
    assert.ok(!boundary.allow.packages.includes(docsProtocolAgentTeamsName), boundary.id);
  }
  const foundationLocalMode = policy.boundaries.find(({ id }) => id === "foundation.local-mode");
  assert.deepEqual(foundationLocalMode.allow.builtins, [
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
      "docs-protocol.community.bootstrap",
      "docs-protocol.community.context",
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
      packages: [foundationName, repositoryMutationName],
      builtins: ["node:path"],
      entrypoints: [
        "packages/docs-protocol/src/domain/document-semantics.ts",
        "packages/docs-protocol/src/domain/model.ts",
        "packages/docs-protocol/src/domain/model-v2.ts",
        "packages/docs-protocol/src/domain/model-v3.ts",
        "packages/docs-protocol/src/domain/profile-policy.ts",
      ],
    },
    "docs-protocol.application": {
      roots: ["packages/docs-protocol/src/application"],
      boundaries: ["docs-protocol.community.context", "docs-protocol.domain"],
      packages: [foundationName, repositoryMutationName, "yaml"],
      builtins: [],
      entrypoints: ["packages/docs-protocol/src/application/docs-protocol.ts"],
    },
    "docs-protocol.adapters": {
      roots: ["packages/docs-protocol/src/adapters"],
      boundaries: ["docs-protocol.application", "docs-protocol.domain"],
      packages: [foundationName, repositoryMutationName, "ajv", "ajv-formats", "yaml"],
      builtins: ["node:fs", "node:fs/promises", "node:path", "node:url"],
      entrypoints: [
        "packages/docs-protocol/src/adapters/docs-command-envelope-schema-validator.ts",
        "packages/docs-protocol/src/adapters/foundation-docs-port.ts",
        "packages/docs-protocol/src/adapters/node-adoption-inspector.ts",
        "packages/docs-protocol/src/adapters/node-code-anchor-matcher.ts",
        "packages/docs-protocol/src/adapters/node-profile-reader.ts",
        "packages/docs-protocol/src/adapters/node-profile-discovery.ts",
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
        "docs-protocol.community.bootstrap",
        "docs-protocol.community.context",
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
    "docs-protocol.community.context": {
      roots: ["packages/docs-protocol/src/community/context"],
      boundaries: ["docs-protocol.domain"],
      packages: ["minisearch"],
      builtins: [],
      entrypoints: ["packages/docs-protocol/src/community/context/index.ts"],
    },
    "docs-protocol.community.bootstrap": {
      roots: ["packages/docs-protocol/src/community/bootstrap"],
      boundaries: ["docs-protocol.domain"],
      packages: [foundationName, repositoryMutationName],
      builtins: ["node:crypto", "node:fs", "node:fs/promises", "node:path"],
      entrypoints: [
        "packages/docs-protocol/src/community/bootstrap/index.ts",
        "packages/docs-protocol/src/community/bootstrap/portable-bootstrap-assets.ts",
      ],
    },
    "docs-protocol.qualification": {
      roots: ["packages/docs-protocol/src/qualification"],
      boundaries: [
        "docs-protocol.adapters",
        "docs-protocol.application",
        "docs-protocol.community.bootstrap",
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

test("Docs Protocol MCP retains one governed read-only package boundary", async () => {
  const policy = parseYaml(await readFile(join(
    repositoryRoot,
    "architecture/foundation/source-dependencies.yaml",
  ), "utf8"));
  const boundary = policy.boundaries.find(({ id }) => id === "docs-protocol-mcp.surface");
  assert.deepEqual(boundary, {
    id: "docs-protocol-mcp.surface",
    packageExports: ["."],
    roots: ["packages/docs-protocol-mcp/src"],
    allow: {
      boundaries: [],
      packages: [docsProtocolName, "@modelcontextprotocol/server"],
      builtins: ["node:fs/promises", "node:module", "node:path"],
      runtimeReferences: [],
    },
    entrypoints: [
      "packages/docs-protocol-mcp/src/index.ts",
      "packages/docs-protocol-mcp/src/cli.ts",
    ],
  });
  const sources = await sourceFiles(join(repositoryRoot, "packages/docs-protocol-mcp/src"));
  const specifiers = (await Promise.all(sources.map((path) => readFile(path, "utf8"))))
    .flatMap(importedSpecifiers);
  assert.deepEqual(
    [...new Set(specifiers.filter((specifier) => specifier.startsWith("node:")))].toSorted(),
    boundary.allow.builtins.toSorted(),
  );
  assert.deepEqual(
    [...new Set(specifiers.map(packageName).filter(Boolean))].toSorted(),
    boundary.allow.packages.toSorted(),
  );
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
        exports: { ".": "./src/composition/index.ts" },
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

test("Agent Teams consumer integration is absent from Core and owned by its adapter", async () => {
  const policy = parseYaml(await readFile(join(
    repositoryRoot,
    "architecture/foundation/source-dependencies.yaml",
  ), "utf8"));
  const coreBoundaries = policy.boundaries.filter((boundary) =>
    boundary.roots.some((root) => root.startsWith("packages/docs-protocol/src/")),
  );
  for (const boundary of coreBoundaries) {
    assert.ok(
      boundary.roots.every((root) => !root.includes("/consumer-integration/")),
      boundary.id,
    );
    assert.ok(!boundary.allow.packages.includes(docsProtocolAgentTeamsName), boundary.id);
    assert.ok(
      boundary.allow.boundaries.every((id) => !id.startsWith("docs-protocol-agent-teams.")),
      boundary.id,
    );
  }

  const adapterBoundary = policy.boundaries.find(
    ({ id }) => id === "docs-protocol-agent-teams.adapters",
  );
  assert.deepEqual(adapterBoundary, {
    id: "docs-protocol-agent-teams.adapters",
    roots: ["packages/docs-protocol-agent-teams/src/consumer-integration/adapters"],
    allow: {
      boundaries: [
        "docs-protocol-agent-teams.application",
        "docs-protocol-agent-teams.domain",
      ],
      packages: [
        foundationName,
        repositoryMutationName,
        "ajv",
        "ajv-formats",
        "jsonc-parser",
        "yaml",
      ],
      builtins: [
        "node:child_process",
        "node:crypto",
        "node:fs",
        "node:fs/promises",
        "node:os",
        "node:path",
      ],
      runtimeReferences: [],
    },
    entrypoints: [
      "packages/docs-protocol-agent-teams/src/consumer-integration/adapters/agents-route-adapter-v1.ts",
      "packages/docs-protocol-agent-teams/src/consumer-integration/adapters/consumer-integration-schema-validator.ts",
      "packages/docs-protocol-agent-teams/src/consumer-integration/adapters/consumer-upgrade-file-projectors.ts",
      "packages/docs-protocol-agent-teams/src/consumer-integration/adapters/foundation-known-file-transaction.ts",
      "packages/docs-protocol-agent-teams/src/consumer-integration/adapters/github-cohort-authority-reader.ts",
      "packages/docs-protocol-agent-teams/src/consumer-integration/adapters/node-consumer-integration-repository.ts",
      "packages/docs-protocol-agent-teams/src/consumer-integration/adapters/node-consumer-upgrade-sandbox.ts",
      "packages/docs-protocol-agent-teams/src/consumer-integration/adapters/package-consumer-asset-catalog.ts",
      "packages/docs-protocol-agent-teams/src/consumer-integration/adapters/pnpm-manifest-adapter-v1.ts",
      "packages/docs-protocol-agent-teams/src/consumer-integration/adapters/pnpm-runtime-closure-v1.ts",
    ],
  });

  const applicationSources = await sourceFiles(join(
    repositoryRoot,
    "packages/docs-protocol-agent-teams/src/consumer-integration/application",
  ));
  for (const path of applicationSources) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /(?:^|\/)adapters(?:\/|$)/u, path);
    assert.doesNotMatch(source, /node:(?:child_process|fs|module|os|path|url)/u, path);
  }
});

test("Agent Teams adapter policy classifies new application files and rejects adapter imports", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "docs-consumer-boundary-"));
  try {
    const policy = parseYaml(await readFile(join(
      repositoryRoot,
      "architecture/foundation/source-dependencies.yaml",
    ), "utf8"));
    const relevantBoundaryIds = new Set([
      "docs-protocol-agent-teams.adapters",
      "docs-protocol-agent-teams.application",
      "docs-protocol-agent-teams.domain",
      "docs-protocol-agent-teams.generated-assets",
    ]);
    const fixturePolicy = {
      schemaVersion: 2,
      workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
      packageRoots: ["packages"],
      governedRoots: ["packages/docs-protocol-agent-teams/src/consumer-integration"],
      boundaries: policy.boundaries
        .filter(({ id }) => relevantBoundaryIds.has(id))
        .map((boundary) => ({
          ...boundary,
          entrypoints: boundary.id.endsWith(".adapters")
            ? ["packages/docs-protocol-agent-teams/src/consumer-integration/adapters/node-consumer-integration-repository.ts"]
            : boundary.id.endsWith(".domain")
              ? ["packages/docs-protocol-agent-teams/src/consumer-integration/domain/model.ts"]
              : [],
        })),
    };
    const paths = {
      application: join(
        temporaryRoot,
        "packages/docs-protocol-agent-teams/src/consumer-integration/application/use-cases/new-use-case.ts",
      ),
      adapter: join(
        temporaryRoot,
        "packages/docs-protocol-agent-teams/src/consumer-integration/adapters/node-consumer-integration-repository.ts",
      ),
      domain: join(
        temporaryRoot,
        "packages/docs-protocol-agent-teams/src/consumer-integration/domain/model.ts",
      ),
      generated: join(
        temporaryRoot,
        "packages/docs-protocol-agent-teams/src/consumer-integration/generated",
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
      writeFile(join(temporaryRoot, "packages/docs-protocol-agent-teams/package.json"), `${JSON.stringify({
        name: docsProtocolAgentTeamsName,
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
    "packages/repository-mutation/src/repository-mutation/adapters/node/node-directory-materialization.ts",
  ), "utf8");
  assert.match(production, /@agent-teams\/repository-mutation\/node/iu); assert.match(generic, /node-create-and-bind-directory\.js/iu);
  for (const source of [production, generic]) {
    assert.match(source, /createAndBindNodeDirectory\s*\(/u);
  }
  const publicMutationBarrel = await readFile(join(
    repositoryRoot,
    "packages/repository-mutation/src/index.ts",
  ), "utf8");
  assert.doesNotMatch(publicMutationBarrel, /createAndBindNodeDirectory/u);
});
