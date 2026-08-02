import { writeFile } from "node:fs/promises";
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
  "workspace.dependency-declarations"
];

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
    include: ["src/**/*.ts"]
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

export async function verifyPackedConsumer(input) {
  const fixture = input.fixture;
  await assertAdrPromotion(fixture);
  await assertCapabilityCheck(fixture);
  await assertSourceGraphViolation(fixture);
  await assertJsonSchemaFormats(fixture);
  await assertBasePresets(fixture);
  await assertMaintainabilityPresets(fixture);
  await assertTypeAwarePreset(fixture);
  await assertSelfCheck(fixture);
  await assertCapabilityCheck(fixture);
}
