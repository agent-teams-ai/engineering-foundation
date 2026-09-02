import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  canonicalDigest,
  readJson,
  syntheticDigest,
  writeJson
} from "./pack-test-support.mjs";
import { writePackedConsumerProtobufFixture } from "./packed-consumer-protobuf-fixture.mjs";
import { writeExecutableSpecificationFixture } from "./packed-consumer-executable-specification-fixture.mjs";

const foundationPackage = "@agent-teams/engineering-foundation";
const identitySource = "export function identity(value: string): string {\n  return value;\n}\n";

function consumerManifest(foundationVersion, packageManager) {
  return {
    name: "foundation-pack-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager,
    scripts: {
      "spec:typegen": "consumer-owned-type-generation",
      "spec:property": "consumer-owned-property-tests",
      "spec:mutation": "consumer-owned-mutation-tests"
    },
    devDependencies: {
      [foundationPackage]: foundationVersion,
      "jsonc-parser": "catalog:",
      oxlint: "catalog:",
      "oxlint-tsgolint": "catalog:",
      typescript: "catalog:"
    }
  };
}

async function writeInstallManifests(input) {
  await writeJson(
    join(input.consumerRoot, "package.json"),
    consumerManifest(input.foundationVersion, input.packageManager)
  );
  await writeFile(
    join(input.consumerRoot, "pnpm-workspace.yaml"),
    `packages:\n  - "packages/*"\noverrides:\n  "@agent-teams/document-authoring": ${JSON.stringify(input.documentAuthoringArchiveFileSpecifier)}\n  "@agent-teams/repository-mutation": ${JSON.stringify(input.mutationArchiveFileSpecifier)}\ncatalogMode: strict\ncatalog:\n  jsonc-parser: 3.3.1\n  oxlint: ${input.toolingVersions.oxlint}\n  oxlint-tsgolint: ${input.toolingVersions.oxlintTsgolint}\n  typescript: ${input.toolingVersions.typescript}\n`,
    "utf8"
  );
}

async function installPackedPackage(input) {
  await writeInstallManifests({
    ...input,
    foundationVersion: input.archiveFileSpecifier
  });
  await input.runPnpm(
    ["install", "--ignore-scripts", "--no-frozen-lockfile"],
    input.consumerRoot
  );
  const { stdout: versionOutput } = await input.runPnpm(
    ["exec", "agent-teams-foundation", "--version"],
    input.consumerRoot
  );
  const packedManifest = await readJson(
    join(input.consumerRoot, "node_modules", "@agent-teams", "engineering-foundation", "package.json")
  );
  if (versionOutput.trim() !== packedManifest.version) {
    throw new Error("Packed CLI version differs from packed package version.");
  }
  await writeJson(
    join(input.consumerRoot, "package.json"),
    consumerManifest(packedManifest.version, input.packageManager)
  );
  return packedManifest;
}

async function writeScaffoldingTypeConsumer(consumerRoot) {
  const typeConsumerRoot = join(consumerRoot, "type-consumer");
  await mkdir(typeConsumerRoot, { recursive: true });
  await writeFile(
    join(typeConsumerRoot, "scaffold-target-catalog.ts"),
    [
      "import type { ScaffoldTargetCatalog } from \"@agent-teams/engineering-foundation/scaffolding\";",
      "",
      "export const schemaShapedTargetCatalog = {",
      "  version: 1,",
      "  packages: [",
      "    {",
      "      id: \"testing.generated\",",
      "      role: \"testing-package\",",
      "      path: \"packages/testing/generated\",",
      "      package_name: \"@fixture/generated\",",
      "      owner_document: \"ADR-0001\"",
      "    }",
      "  ]",
      "} satisfies ScaffoldTargetCatalog;",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeFoundationConfiguration(consumerRoot) {
  await mkdir(join(consumerRoot, "architecture", "foundation"), { recursive: true });
  await writeFile(
    join(consumerRoot, "foundation.config.yaml"),
    `schemaVersion: 1
project:
  id: pack-consumer
capabilities:
  architecture.source-dependencies:
    configPath: architecture/foundation/source-dependencies.yaml
  contract.json-schema-releases:
    configPath: architecture/foundation/json-schema-releases.yaml
  contract.protobuf-evolution:
    configPath: architecture/foundation/protobuf-evolution.yaml
  documentation.local-references:
    configPath: architecture/foundation/documentation-local-references.yaml
  governance.architecture-decisions:
    configPath: architecture/foundation/governance-architecture-decisions.yaml
  package.public-api-compatibility:
    configPath: architecture/foundation/public-api-compatibility.yaml
  quality.executable-specifications:
    configPath: architecture/foundation/executable-specifications.yaml
  quality.suppression-governance:
    configPath: architecture/foundation/suppression-governance.yaml
  repository.security-baseline:
    configPath: architecture/foundation/repository-security-baseline.yaml
  workspace.dependency-declarations:
    configPath: architecture/foundation/dependency-declarations.yaml
`,
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "architecture", "foundation", "dependency-declarations.yaml"),
    `schemaVersion: 1
packageManager:
  kind: pnpm
  workspaceManifest: pnpm-workspace.yaml
policies:
  externalDependencies: catalog
  catalogVersions: exact
  internalDependencies: workspace-protocol
  reservedScopes:
    - "@agent-teams/"
  developmentOnlyPackages:
    - oxlint
    - oxlint-tsgolint
    - typescript
  exactRegistryDevelopmentOnlyPackages:
    - "@agent-teams/engineering-foundation"
`,
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "architecture", "foundation", "source-dependencies.yaml"),
    `schemaVersion: 1
workspace:
  kind: pnpm
  manifest: pnpm-workspace.yaml
governedRoots:
  - src
boundaries:
  - id: pack-consumer.core
    roots:
      - src/index.ts
    entrypoints:
      - src/index.ts
    allow:
      boundaries: []
      packages: []
      builtins: []
      runtimeReferences: []
  - id: pack-consumer.specifications
    dependencyMode: development
    roots:
      - src/generated-event.ts
    entrypoints:
      - src/generated-event.ts
    allow:
      boundaries: []
      packages:
        - jsonc-parser
      builtins: []
      runtimeReferences: []
`,
    "utf8"
  );
  await writeJson(
    join(consumerRoot, "architecture", "foundation", "documentation-local-references.yaml"),
    { schemaVersion: 1, markdownRoots: ["docs"], anchorProfile: "github" }
  );
  await writeJson(
    join(consumerRoot, "architecture", "foundation", "governance-architecture-decisions.yaml"),
    {
      schemaVersion: 1,
      adrRoots: ["docs/decisions"],
      index: {
        path: "docs/decisions/README.md",
        sections: { proposed: "Proposed", accepted: "Accepted", superseded: "Superseded" }
      },
      acceptedBaselinePath: "architecture/decisions/accepted-decisions.json"
    }
  );
}

async function writeDocumentationFixture(consumerRoot) {
  const decisionsRoot = join(consumerRoot, "docs", "decisions");
  await mkdir(decisionsRoot, { recursive: true });
  await writeFile(
    join(consumerRoot, "docs", "README.md"),
    "# Packaged Consumer\n\nSee the [guide](guide.md#packaged-guide) and [decisions](decisions/README.md).\n",
    "utf8"
  );
  await writeFile(join(consumerRoot, "docs", "guide.md"), "# Packaged Guide\n\nThe installed Foundation package governs this clean consumer.\n", "utf8");
  await writeFile(
    join(decisionsRoot, "README.md"),
    "# Architecture Decisions\n\n## Proposed\n\n## Accepted\n\n- [ADR-0001: Verify packaged capabilities](0001-verify-packaged-capabilities.md)\n\n## Superseded\n",
    "utf8"
  );
  await writeFile(
    join(decisionsRoot, "0001-verify-packaged-capabilities.md"),
    "---\nid: ADR-0001\nstatus: accepted\nsupersedes: []\nsuperseded_by: []\n---\n\n# ADR-0001: Verify Packaged Capabilities\n\nStatus: Accepted\n\n## Decision\n\nThe clean consumer executes capabilities from the packed artifact.\n",
    "utf8"
  );
}

function createJsonContractEvidence() {
  const schemaId = "https://schemas.example.test/pack-consumer/event.schema.json";
  const eventSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: schemaId,
    type: "object",
    additionalProperties: false,
    required: ["contact"],
    properties: { contact: { type: "string", format: "email" } }
  };
  const validFixture = { contact: "runtime@example.test" };
  const invalidFixture = { contact: "not-an-email" };
  const fixtures = [
    {
      id: "invalid-payload",
      path: "contracts/json-schema/fixtures/invalid.json",
      schemaId,
      expectation: "invalid"
    },
    {
      id: "valid-payload",
      path: "contracts/json-schema/fixtures/valid.json",
      schemaId,
      expectation: "valid"
    }
  ];
  const schemaSetDigest = canonicalDigest([{ id: schemaId, schema: eventSchema }]);
  const fixtureCorpusDigest = canonicalDigest([
    { id: fixtures[0].id, schemaId, expectation: fixtures[0].expectation, value: invalidFixture },
    { id: fixtures[1].id, schemaId, expectation: fixtures[1].expectation, value: validFixture }
  ]);
  const consumerEvidence = {
    consumerId: "pack-consumer",
    consumerVersion: "1.0.0",
    contractId: "pack-consumer.events",
    contractVersion: "1.0.0",
    schemaSetDigest,
    fixtureCorpusDigest,
    evidenceDigest: syntheticDigest("e"),
    outcome: "passed"
  };
  return { consumerEvidence, eventSchema, fixtureCorpusDigest, fixtures, invalidFixture, schemaSetDigest, validFixture };
}

async function writeJsonContractFixture(consumerRoot) {
  const evidence = createJsonContractEvidence();
  const contractRoot = join(consumerRoot, "contracts", "json-schema");
  await writeJson(join(contractRoot, "event.schema.json"), evidence.eventSchema);
  await writeJson(join(contractRoot, "fixtures", "valid.json"), evidence.validFixture);
  await writeJson(join(contractRoot, "fixtures", "invalid.json"), evidence.invalidFixture);
  await writeJson(join(consumerRoot, "architecture", "contracts", "json-schema", "pack-consumer.events.json"), {
    schemaVersion: 1,
    contractId: "pack-consumer.events",
    publicContractVersion: "1.0.0",
    schemaSetDigest: evidence.schemaSetDigest,
    fixtureCorpusDigest: evidence.fixtureCorpusDigest,
    supportedConsumers: [evidence.consumerEvidence]
  });
  await writeJson(
    join(consumerRoot, "architecture", "foundation", "json-schema-releases.yaml"),
    {
      schemaVersion: 1,
      contractId: "pack-consumer.events",
      publicContractVersion: "1.0.0",
      schemaPaths: ["contracts/json-schema/event.schema.json"],
      fixtures: evidence.fixtures,
      releasedBaselinePath: "architecture/contracts/json-schema/pack-consumer.events.json",
      currentConsumerEvidence: [evidence.consumerEvidence]
    }
  );
  return evidence;
}

async function writePublicApiFixture(consumerRoot) {
  const packageRoot = join(consumerRoot, "packages", "library");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await mkdir(join(consumerRoot, ".changeset"), { recursive: true });
  await writeFile(
    join(packageRoot, "dist", "index.d.ts"),
    "export declare function stable(value: string): string;\n",
    "utf8"
  );
  await writeFile(
    join(packageRoot, "dist", "local-mode.d.ts"),
    "export declare function stable(value: string): string;\n",
    "utf8"
  );
  await writeJson(join(packageRoot, "package.json"), {
    name: "@fixture/public-api",
    version: "1.2.3",
    type: "module",
    files: ["dist"],
    publishConfig: { provenance: true },
    exports: {
      ".": { types: "./dist/index.d.ts" },
      "./local-mode": { types: "./dist/local-mode.d.ts" }
    }
  });
  await writeJson(join(packageRoot, "tsconfig.json"), {
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      target: "ES2024"
    },
    include: ["dist/*.d.ts"]
  });
  await writeFile(
    join(consumerRoot, "architecture", "foundation", "public-api-compatibility.yaml"),
    [
      "schemaVersion: 1",
      "acceptedDecisionBaselinePath: architecture/decisions/accepted-decisions.json",
      "changesetDirectory: .changeset",
      "packages:",
      "  - packageName: \"@fixture/public-api\"",
      "    packageRoot: packages/library",
      "    manifestPath: packages/library/package.json",
      "    entrypoints:",
      "      - exportPath: .",
      "        declarationEntryPoint: packages/library/dist/index.d.ts",
      "      - exportPath: ./local-mode",
      "        declarationEntryPoint: packages/library/dist/local-mode.d.ts",
      "    nonTypeExports: []",
      "    tsconfigPath: packages/library/tsconfig.json",
      "    releasedBaselinePath: architecture/public-api/public-api.json",
      "    approvedBreakingChanges: []",
      ""
    ].join("\n"),
    "utf8"
  );
  const stableItem = {
    canonicalReference: "@fixture/public-api!stable:function(1)",
    kind: "Function",
    parentReference: "@fixture/public-api!",
    parentKind: "EntryPoint",
    signature: "export declare function stable(value: string): string;"
  };
  await writeJson(join(consumerRoot, "architecture", "public-api", "public-api.json"), {
    schemaVersion: 1,
    packageName: "@fixture/public-api",
    packageVersion: "1.2.3",
    extractorVersion: "7.58.12",
    entrypoints: [
      { exportPath: ".", items: [stableItem] },
      { exportPath: "./local-mode", items: [stableItem] }
    ]
  });
}

async function writeSuppressionGovernanceFixture(consumerRoot) {
  await writeFile(
    join(consumerRoot, "architecture", "foundation", "suppression-governance.yaml"),
    [
      "schemaVersion: 1",
      "governedRoots:",
      "  - src",
      "nonWaivableRulePrefixes:",
      "  - access-control.",
      "waivers: []",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeRepositorySecurityFixture(consumerRoot) {
  const workflowsRoot = join(consumerRoot, ".github", "workflows");
  await mkdir(workflowsRoot, { recursive: true });
  await writeFile(
    join(workflowsRoot, "ci.yml"),
    [
      "name: CI",
      "on:",
      "  pull_request:",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  dependency-review:",
      "    runs-on: ubuntu-24.04",
      "    steps:",
      "      - uses: actions/dependency-review-action@2222222222222222222222222222222222222222",
      "        with:",
      "          base-ref: refs/heads/main",
      "          head-ref: refs/pull/current/head",
      "          fail-on-severity: moderate",
      "          vulnerability-check: true",
      "          warn-only: false",
      "  check:",
      "    needs: dependency-review",
      "    runs-on: ubuntu-24.04",
      "    steps:",
      "      - uses: actions/checkout@1111111111111111111111111111111111111111",
      "      - uses: anchore/sbom-action@3333333333333333333333333333333333333333",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "architecture", "foundation", "repository-security-baseline.yaml"),
    [
      "schemaVersion: 1",
      "workflowDirectory: .github/workflows",
      "dependencyReview:",
      "  workflowPath: .github/workflows/ci.yml",
      "  jobId: dependency-review",
      "  baseRef: refs/heads/main",
      "  headRef: refs/pull/current/head",
      "  failOnSeverity: moderate",
      "sbomWorkflow: .github/workflows/ci.yml",
      "allowedContainerImages: []",
      "allowedUses:",
      "  - uses: actions/checkout@1111111111111111111111111111111111111111",
      "    transitiveUses: []",
      "  - uses: actions/dependency-review-action@2222222222222222222222222222222222222222",
      "    transitiveUses: []",
      "  - uses: anchore/sbom-action@3333333333333333333333333333333333333333",
      "    transitiveUses: []",
      "privilegedJobs: []",
      "publishablePackageManifests:",
      "  - packages/library/package.json",
      ""
    ].join("\n"),
    "utf8"
  );
}

function resolveConsumerToolEntrypoints(consumerRoot) {
  const requireFromConsumer = createRequire(join(consumerRoot, "package.json"));
  const foundationRoot = dirname(requireFromConsumer.resolve(`${foundationPackage}/package.json`));
  return {
    foundationRoot,
    foundationCli: join(foundationRoot, "dist", "cli.js"),
    oxlint: join(dirname(requireFromConsumer.resolve("oxlint/package.json")), "bin", "oxlint"),
    typescript: join(
      dirname(requireFromConsumer.resolve("typescript/package.json")),
      "lib",
      "tsc.js"
    )
  };
}

export async function createPackedConsumerFixture(input) {
  await mkdir(input.consumerRoot, { recursive: true });
  const packedManifest = await installPackedPackage(input);
  await writeScaffoldingTypeConsumer(input.consumerRoot);
  const toolEntrypoints = resolveConsumerToolEntrypoints(input.consumerRoot);
  await writeFoundationConfiguration(input.consumerRoot);
  await writeDocumentationFixture(input.consumerRoot);
  const jsonContract = await writeJsonContractFixture(input.consumerRoot);
  await mkdir(join(input.consumerRoot, "src"), { recursive: true });
  await writeExecutableSpecificationFixture(input.consumerRoot, jsonContract);
  await mkdir(join(input.consumerRoot, "fixtures", "outside-duplicate"), { recursive: true });
  await writeJson(join(input.consumerRoot, "fixtures", "outside-duplicate", "package.json"), {
    name: "foundation-pack-consumer",
    scripts: { "spec:typegen": "outside-workspace-duplicate" }
  });
  await mkdir(join(input.consumerRoot, "fixtures", "outside-gates"), { recursive: true });
  await writeJson(join(input.consumerRoot, "fixtures", "outside-gates", "package.json"), {
    name: "foundation-pack-outside-gates",
    scripts: {
      "spec:typegen": "outside-type-generation",
      "spec:property": "outside-property-tests",
      "spec:mutation": "outside-mutation-tests"
    }
  });
  await writePackedConsumerProtobufFixture(
    input.consumerRoot,
    toolEntrypoints.foundationRoot
  );
  await writePublicApiFixture(input.consumerRoot);
  await writeSuppressionGovernanceFixture(input.consumerRoot);
  await writeRepositorySecurityFixture(input.consumerRoot);
  const sourceRoot = join(input.consumerRoot, "src");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, "index.ts"), identitySource, "utf8");
  return Object.freeze({
    consumerRoot: input.consumerRoot,
    identitySource,
    jsonContract,
    packedManifest,
    sourceRoot,
    toolEntrypoints
  });
}
