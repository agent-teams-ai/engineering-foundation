import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  captureFailure,
  runCommand,
  writeJson
} from "./pack-test-support.mjs";

const expectedCapabilityIds = [
  "architecture.source-dependencies",
  "contract.json-schema-releases",
  "contract.protobuf-evolution",
  "documentation.local-references",
  "governance.architecture-decisions",
  "package.public-api-compatibility",
  "quality.executable-specifications",
  "quality.suppression-governance",
  "repository.security-baseline",
  "workspace.dependency-declarations"
];

async function assertPrivateMutationImportsRejected(fixture) {
  const privateSpecifiers = [
    "@agent-teams/engineering-foundation/repository-mutation",
    "@agent-teams/engineering-foundation/dist/repository-mutation/application/model/repository-path.js"
  ];
  for (const specifier of privateSpecifiers) {
    const failure = await captureFailure(() => runCommand(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(specifier)})`],
      fixture.consumerRoot
    ));
    if (failure?.code !== 1 || !failure.stderr?.includes("ERR_PACKAGE_PATH_NOT_EXPORTED")) {
      throw new Error(`Packed private import was not rejected for ${specifier}.`);
    }
  }
}

async function runFoundationJson(fixture, args) {
  const { stdout } = await runCommand(
    process.execPath,
    [fixture.toolEntrypoints.foundationCli, ...args],
    fixture.consumerRoot
  );
  return JSON.parse(stdout);
}

async function captureFoundationFailure(fixture, args) {
  const error = await captureFailure(() =>
    runCommand(
      process.execPath,
      [fixture.toolEntrypoints.foundationCli, ...args],
      fixture.consumerRoot
    )
  );
  return error === undefined ? undefined : JSON.parse(error.stdout ?? "null");
}

async function assertAdrPromotion(fixture) {
  const args = [
    "architecture-decisions-promote-baseline",
    "--consumer",
    fixture.consumerRoot,
    "--json"
  ];
  const initial = await runFoundationJson(fixture, args);
  if (initial.promotion?.writeResult !== "created") {
    throw new Error("Packed ADR baseline promotion did not create an immutable baseline.");
  }
  const replay = await runFoundationJson(fixture, args);
  if (replay.promotion?.writeResult !== "unchanged") {
    throw new Error("Packed ADR baseline promotion was not idempotent.");
  }
}

async function assertCapabilityCheck(fixture) {
  const report = await runFoundationJson(fixture, [
    "check",
    "--consumer",
    fixture.consumerRoot,
    "--format",
    "json"
  ]);
  const observedIds = report.capabilities?.map((capability) => capability.capabilityId);
  if (report.outcome !== "passed" || observedIds?.join(",") !== expectedCapabilityIds.join(",")) {
    throw new Error("Packed executable capability check did not pass.");
  }
}

async function assertSourceGraphViolation(fixture) {
  const sourcePath = join(fixture.sourceRoot, "index.ts");
  await writeFile(sourcePath, 'import "node:fs";\nexport const invalidBoundary = true;\n', "utf8");
  const report = await captureFoundationFailure(fixture, [
    "check",
    "--consumer",
    fixture.consumerRoot,
    "--format",
    "json"
  ]);
  if (
    report?.capabilities?.[0]?.diagnostics?.[0]?.ruleId !==
    "architecture.source-dependencies.forbidden-builtin-dependency"
  ) {
    throw new Error("Packed source capability did not reject a forbidden builtin.");
  }
  await writeFile(sourcePath, fixture.identitySource, "utf8");
}

async function assertJsonSchemaFormats(fixture) {
  const fixturePath = join(
    fixture.consumerRoot,
    "contracts",
    "json-schema",
    "fixtures",
    "valid.json"
  );
  await writeJson(fixturePath, fixture.jsonContract.invalidFixture);
  const report = await captureFoundationFailure(fixture, [
    "check",
    "--consumer",
    fixture.consumerRoot,
    "--format",
    "json"
  ]);
  const capability = report?.capabilities?.find(
    (candidate) => candidate.capabilityId === "contract.json-schema-releases"
  );
  const rejected = capability?.diagnostics?.some(
    (diagnostic) =>
      diagnostic.ruleId === "contract.json-schema-releases.fixture-expectation-failed"
  );
  if (rejected !== true) {
    throw new Error("Packed JSON Schema capability did not reject a mismatched fixture.");
  }
  await writeJson(fixturePath, fixture.jsonContract.validFixture);
}

async function assertExecutableSpecifications(fixture) {
  const documentPath = join(
    fixture.consumerRoot,
    "contracts",
    "json-schema",
    "fixtures",
    "valid.json"
  );
  await writeJson(documentPath, fixture.jsonContract.invalidFixture);
  const report = await captureFoundationFailure(fixture, [
    "check",
    "--consumer",
    fixture.consumerRoot,
    "--format",
    "json"
  ]);
  const capability = capabilityFromReport(report, "quality.executable-specifications");
  const rejected = capability?.diagnostics?.some(
    (diagnostic) =>
      diagnostic.ruleId === "quality.executable-specifications.document-invalid"
  );
  if (rejected !== true) {
    throw new Error("Packed executable specification capability accepted an invalid document.");
  }
  await writeJson(documentPath, fixture.jsonContract.validFixture);
}

async function assertStrictExecutableSpecificationCatalog(fixture) {
  const catalogPath = join(
    fixture.consumerRoot,
    "architecture",
    "specifications",
    "catalog.json"
  );
  const source = await readFile(catalogPath, "utf8");
  await writeFile(
    catalogPath,
    source.replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1'),
    "utf8"
  );
  const report = await captureFoundationFailure(fixture, [
    "check",
    "--consumer",
    fixture.consumerRoot,
    "--format",
    "json"
  ]);
  const capability = capabilityFromReport(report, "quality.executable-specifications");
  if (capability?.problem?.code !== "EXECUTABLE_SPECIFICATION_CATALOG_DUPLICATE_KEY") {
    throw new Error("Packed executable specification catalog accepted a duplicate key.");
  }
  await writeFile(catalogPath, source, "utf8");
}

async function assertExecutableGatePackagesAreWorkspaceScoped(fixture) {
  const catalogPath = join(
    fixture.consumerRoot,
    "architecture",
    "specifications",
    "catalog.json"
  );
  const source = await readFile(catalogPath, "utf8");
  const catalog = JSON.parse(source);
  for (const binding of Object.values(catalog.specifications[0].gateBindings)) {
    binding.packageName = "foundation-pack-outside-gates";
  }
  await writeJson(catalogPath, catalog);
  const report = await captureFoundationFailure(fixture, [
    "check",
    "--consumer",
    fixture.consumerRoot,
    "--format",
    "json"
  ]);
  const capability = capabilityFromReport(report, "quality.executable-specifications");
  const missingGateCount = capability?.diagnostics?.filter(
    (diagnostic) =>
      diagnostic.ruleId === "quality.executable-specifications.gate-missing"
  ).length;
  if (missingGateCount !== 3) {
    throw new Error("Packed executable specification accepted an out-of-workspace gate package.");
  }
  await writeFile(catalogPath, source, "utf8");
}

async function assertDevelopmentBoundaryMode(fixture) {
  const configPath = join(
    fixture.consumerRoot,
    "architecture",
    "foundation",
    "source-dependencies.yaml"
  );
  const source = await readFile(configPath, "utf8");
  await writeFile(configPath, source.replace("    dependencyMode: development\n", ""), "utf8");
  const report = await captureFoundationFailure(fixture, [
    "check",
    "--consumer",
    fixture.consumerRoot,
    "--format",
    "json"
  ]);
  const capability = capabilityFromReport(report, "architecture.source-dependencies");
  const rejected = capability?.diagnostics?.some(
    (diagnostic) =>
      diagnostic.ruleId ===
      "architecture.source-dependencies.runtime-import-from-development-dependency"
  );
  if (rejected !== true) {
    throw new Error("Packed runtime boundary accepted a runtime devDependency import.");
  }
  await writeFile(configPath, source, "utf8");
}

function capabilityFromReport(report, capabilityId) {
  return report?.capabilities?.find((candidate) => candidate.capabilityId === capabilityId);
}

async function assertPublicApiCompatibility(fixture) {
  const declarationPath = join(
    fixture.consumerRoot,
    "packages",
    "library",
    "dist",
    "local-mode.d.ts"
  );
  await writeFile(
    declarationPath,
    "export declare function stable(value: number): string;\n",
    "utf8"
  );
  const report = await captureFoundationFailure(fixture, [
    "check",
    "--consumer",
    fixture.consumerRoot,
    "--format",
    "json"
  ]);
  const capability = capabilityFromReport(report, "package.public-api-compatibility");
  const rejected = capability?.diagnostics?.some(
    (diagnostic) =>
      diagnostic.ruleId === "package.public-api-compatibility.breaking-change-not-approved"
  );
  if (rejected !== true) {
    throw new Error("Packed public API capability did not reject an unapproved breaking change.");
  }
  await writeFile(
    declarationPath,
    "export declare function stable(value: string): string;\n",
    "utf8"
  );
}

async function assertSuppressionGovernance(fixture) {
  const sourcePath = join(fixture.sourceRoot, "index.ts");
  await writeFile(
    sourcePath,
    '// oxlint-disable-next-line no-console\nconsole.log("unregistered suppression");\n',
    "utf8"
  );
  const report = await captureFoundationFailure(fixture, [
    "check",
    "--consumer",
    fixture.consumerRoot,
    "--format",
    "json"
  ]);
  const capability = capabilityFromReport(report, "quality.suppression-governance");
  const rejected = capability?.diagnostics?.some(
    (diagnostic) =>
      diagnostic.ruleId === "quality.suppression-governance.unregistered-suppression"
  );
  if (rejected !== true) {
    throw new Error("Packed suppression capability did not reject an unregistered suppression.");
  }
  await writeFile(sourcePath, fixture.identitySource, "utf8");
}

async function assertRepositorySecurityBaseline(fixture) {
  const workflowPath = join(fixture.consumerRoot, ".github", "workflows", "ci.yml");
  const validWorkflow = await readFile(workflowPath, "utf8");
  await writeFile(
    workflowPath,
    validWorkflow.replace(
      "actions/checkout@1111111111111111111111111111111111111111",
      "actions/checkout@main"
    ),
    "utf8"
  );
  const report = await captureFoundationFailure(fixture, [
    "check",
    "--consumer",
    fixture.consumerRoot,
    "--format",
    "json"
  ]);
  const capability = capabilityFromReport(report, "repository.security-baseline");
  const rejected = capability?.diagnostics?.some(
    (diagnostic) => diagnostic.ruleId === "repository.security-baseline.action-not-pinned"
  );
  if (rejected !== true) {
    throw new Error("Packed repository security capability did not reject a mutable action reference.");
  }
  await writeFile(workflowPath, validWorkflow, "utf8");
}

function oxlintArguments(fixture, configName) {
  return [
    fixture.toolEntrypoints.oxlint,
    "--config",
    join(fixture.consumerRoot, configName),
    "--deny-warnings",
    "--disable-nested-config",
    fixture.sourceRoot
  ];
}

async function assertBasePresets(fixture) {
  await writeJson(join(fixture.consumerRoot, "tsconfig.json"), {
    extends: "@agent-teams/engineering-foundation/presets/typescript/node.json",
    compilerOptions: { noEmit: true },
    include: ["src/**/*.ts", "type-consumer/**/*.ts"]
  });
  await runCommand(
    process.execPath,
    [fixture.toolEntrypoints.typescript, "--project", join(fixture.consumerRoot, "tsconfig.json")],
    fixture.consumerRoot
  );
  await writeJson(join(fixture.consumerRoot, ".oxlintrc.json"), {
    extends: ["./node_modules/@agent-teams/engineering-foundation/presets/oxlint/node.json"]
  });
  await runCommand(process.execPath, oxlintArguments(fixture, ".oxlintrc.json"), fixture.consumerRoot);
}

async function assertMaintainabilityPresets(fixture) {
  const source = `export function packedHelper(a, b, c, d, e, f) {\n  let result = a + b + c + d + e + f;\n${Array.from({ length: 180 }, () => "  result += 1;").join("\n")}\n  return result;\n}\n`;
  await writeJson(join(fixture.consumerRoot, ".oxlintrc.maintainability.json"), {
    extends: [
      "./node_modules/@agent-teams/engineering-foundation/presets/oxlint/node.json",
      "./node_modules/@agent-teams/engineering-foundation/presets/oxlint/maintainability.json"
    ]
  });
  await writeFile(join(fixture.sourceRoot, "index.ts"), source, "utf8");
  const productionFailure = await captureFailure(() =>
    runCommand(
      process.execPath,
      oxlintArguments(fixture, ".oxlintrc.maintainability.json"),
      fixture.consumerRoot
    )
  );
  const output = `${productionFailure?.stdout ?? ""}${productionFailure?.stderr ?? ""}`;
  if (
    !output.includes("eslint(max-lines-per-function)") ||
    !output.includes("eslint(max-params)")
  ) {
    throw new Error("Packed production maintainability preset did not enforce its budgets.");
  }
  await writeJson(join(fixture.consumerRoot, ".oxlintrc.maintainability-tests.json"), {
    extends: [
      "./node_modules/@agent-teams/engineering-foundation/presets/oxlint/node.json",
      "./node_modules/@agent-teams/engineering-foundation/presets/oxlint/maintainability-tests.json"
    ]
  });
  await runCommand(
    process.execPath,
    oxlintArguments(fixture, ".oxlintrc.maintainability-tests.json"),
    fixture.consumerRoot
  );
}

async function assertTypeAwarePreset(fixture) {
  await writeJson(join(fixture.consumerRoot, ".oxlintrc.type-aware.json"), {
    extends: [
      "./node_modules/@agent-teams/engineering-foundation/presets/oxlint/type-aware.json"
    ]
  });
  await writeFile(
    join(fixture.sourceRoot, "index.ts"),
    "async function execute(): Promise<void> {}\nexecute();\n",
    "utf8"
  );
  const failure = await captureFailure(() =>
    runCommand(
      process.execPath,
      oxlintArguments(fixture, ".oxlintrc.type-aware.json"),
      fixture.consumerRoot
    )
  );
  const output = `${failure?.stdout ?? ""}${failure?.stderr ?? ""}`;
  if (!output.includes("typescript(no-floating-promises)")) {
    throw new Error("Packed type-aware Oxlint preset did not reject a floating promise.");
  }
  await writeFile(join(fixture.sourceRoot, "index.ts"), fixture.identitySource, "utf8");
}

async function assertSelfCheck(fixture) {
  const report = await runFoundationJson(fixture, ["self-check", "--json"]);
  if (
    report.ok !== true ||
    report.packageVersion !== fixture.packedManifest.version ||
    report.localModeProtocolVersion !== 1
  ) {
    throw new Error("Packed CLI self-check did not validate the package.");
  }
}

async function assertDocumentFind(fixture) {
  const result = await runFoundationJson(fixture, [
    "docs",
    "find",
    "hermetic search marker",
    "--consumer",
    fixture.consumerRoot,
    "--json"
  ]);
  if (
    result.command !== "docs.find" ||
    result.outcome !== "success" ||
    result.result?.matches !== 1 ||
    result.result?.documents?.[0]?.id !== "guide.packaged"
  ) {
    throw new Error("Packed docs find did not return the deterministic catalog match.");
  }
}

export async function verifyPackedConsumer(input) {
  const fixture = input.fixture;
  await assertPrivateMutationImportsRejected(fixture);
  await assertAdrPromotion(fixture);
  await assertCapabilityCheck(fixture);
  await assertSourceGraphViolation(fixture);
  await assertJsonSchemaFormats(fixture);
  await assertExecutableSpecifications(fixture);
  await assertStrictExecutableSpecificationCatalog(fixture);
  await assertExecutableGatePackagesAreWorkspaceScoped(fixture);
  await assertDevelopmentBoundaryMode(fixture);
  await assertPublicApiCompatibility(fixture);
  await assertSuppressionGovernance(fixture);
  await assertRepositorySecurityBaseline(fixture);
  await assertBasePresets(fixture);
  await assertMaintainabilityPresets(fixture);
  await assertTypeAwarePreset(fixture);
  await assertDocumentFind(fixture);
  await assertSelfCheck(fixture);
  await assertCapabilityCheck(fixture);
}
