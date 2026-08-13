import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ensurePinnedAqua } from "./security-toolchain.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configuredCliPath = process.env.AGENT_TEAMS_FOUNDATION_CLI_PATH;
if (configuredCliPath !== undefined && !isAbsolute(configuredCliPath)) {
  throw new Error("AGENT_TEAMS_FOUNDATION_CLI_PATH must be absolute when provided.");
}
const cliPath = configuredCliPath ?? join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
  "cli.js"
);
const bufVersion = "1.72.0";
const bufConfigSource =
  "version: v2\nmodules:\n  - path: contracts/protobuf\nbreaking:\n  use:\n    - FILE\n";

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function run(command, arguments_, cwd, acceptedExitCodes = [0], environment = process.env) {
  try {
    const result = await execFileAsync(command, arguments_, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
      env: environment
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const exitCode = typeof error?.code === "number" ? error.code : undefined;
    if (exitCode !== undefined && acceptedExitCodes.includes(exitCode)) {
      return {
        exitCode,
        stdout: typeof error.stdout === "string" ? error.stdout : "",
        stderr: typeof error.stderr === "string" ? error.stderr : ""
      };
    }
    throw error;
  }
}

async function runCli(root, arguments_, acceptedExitCodes = [0]) {
  return run(process.execPath, [cliPath, ...arguments_], root, acceptedExitCodes);
}

function protobufConfig(input) {
  return {
    schemaVersion: 1,
    releasedBaselinePath: "architecture/contracts/protobuf/control.json",
    approvedBreakingChanges: [],
    qualification: {
      modulePath: "contracts/protobuf",
      bufConfigPath: "buf.yaml",
      releasedDescriptorImagePath: "architecture/contracts/protobuf/control.binpb",
      evidencePath: "architecture/evidence/protobuf/control.json"
    },
    current: {
      schemaVersion: 1,
      contractId: "buf-qualification-e2e.control",
      publicContractVersion: input.publicContractVersion,
      bufVersion,
      bufConfigDigest: input.bufConfigDigest,
      descriptorImageDigest: input.descriptorImageDigest,
      generatorVersions: [],
      generationDrift: {
        expectedGeneratedOutputDigest: input.generatedOutputDigest,
        observedGeneratedOutputDigest: input.generatedOutputDigest
      }
    }
  };
}

async function buildDescriptor(bufExecutable, root, outputPath) {
  await mkdir(dirname(join(root, outputPath)), { recursive: true });
  const result = await run(
    bufExecutable,
    [
      "build",
      "contracts/protobuf",
      "--config",
      "buf.yaml",
      "--disable-symlinks",
      "-o",
      outputPath
    ],
    root
  );
  if (result.stdout !== "" || result.stderr !== "") {
    throw new Error("Pinned Buf build emitted unexpected output.");
  }
  return readFile(join(root, outputPath));
}

function qualificationArguments(root, bufExecutable, write = false) {
  return [
    "protobuf-qualify-breaking",
    "--consumer",
    root,
    "--buf-executable",
    bufExecutable,
    ...(write ? ["--write"] : []),
    "--json"
  ];
}

async function resolvePinnedBuf() {
  const aqua = await ensurePinnedAqua();
  const aquaRootDirectory = join(aqua.cacheDirectory, "aqua-runtime");
  await mkdir(aquaRootDirectory, { mode: 0o700, recursive: true });
  const aquaEnvironment = {
    ...process.env,
    AQUA_ENFORCE_CHECKSUM: "true",
    AQUA_ENFORCE_REQUIRE_CHECKSUM: "true",
    AQUA_ROOT_DIR: aquaRootDirectory
  };
  const aquaVersion = await run(
    aqua.executable,
    ["exec", "--", "buf", "--version"],
    repositoryRoot,
    [0],
    aquaEnvironment
  );
  if (aquaVersion.stdout.trim() !== bufVersion) {
    throw new Error(
      `Expected Aqua-managed Buf ${bufVersion}, received ${aquaVersion.stdout.trim() || "missing"}.`
    );
  }
  const which = await run(
    aqua.executable,
    ["which", "buf"],
    repositoryRoot,
    [0],
    aquaEnvironment
  );
  const bufExecutable = which.stdout.trim();
  if (bufExecutable.length === 0) {
    throw new Error("Pinned Buf executable was not resolved by Aqua.");
  }
  const version = await run(bufExecutable, ["--version"], repositoryRoot);
  if (version.stdout.trim() !== bufVersion) {
    throw new Error(`Expected Buf ${bufVersion}, received ${version.stdout.trim() || "missing"}.`);
  }
  return bufExecutable;
}

async function writeInitialFixture(root, bufExecutable) {
  await mkdir(join(root, "contracts", "protobuf"), { recursive: true });
  await writeFile(join(root, "buf.yaml"), bufConfigSource, "utf8");
  await writeFile(
    join(root, "contracts", "protobuf", "control.proto"),
    'syntax = "proto3";\npackage qualification.v1;\nmessage Control {\n  string original = 1;\n}\n',
    "utf8"
  );
  await writeJson(join(root, "foundation.config.yaml"), {
    schemaVersion: 1,
    project: { id: "buf-qualification-e2e" },
    capabilities: {
      "contract.protobuf-evolution": {
        configPath: "architecture/foundation/protobuf-evolution.yaml"
      }
    }
  });
  const baselineBytes = await buildDescriptor(
    bufExecutable,
    root,
    "architecture/contracts/protobuf/control.binpb"
  );
  const bufConfigDigest = sha256(bufConfigSource);
  const baselineDigest = sha256(baselineBytes);
  const generatedOutputDigest = sha256("generated-v1");
  await writeJson(join(root, "architecture", "contracts", "protobuf", "control.json"), {
    schemaVersion: 1,
    contractId: "buf-qualification-e2e.control",
    publicContractVersion: "1.0.0",
    bufVersion,
    bufConfigDigest,
    descriptorImageDigest: baselineDigest,
    generatorVersions: [],
    generatedOutputDigest
  });
  await writeJson(
    join(root, "architecture", "foundation", "protobuf-evolution.yaml"),
    protobufConfig({
      publicContractVersion: "1.0.0",
      bufConfigDigest,
      descriptorImageDigest: baselineDigest,
      generatedOutputDigest
    })
  );
  return bufConfigDigest;
}

async function assertCompatibleQualification(root, bufExecutable) {
  const writeCompatible = JSON.parse((await runCli(
    root,
    qualificationArguments(root, bufExecutable, true)
  )).stdout);
  if (writeCompatible.qualification?.status !== "compatible") {
    throw new Error("Real Buf compatible qualification did not pass.");
  }
  await runCli(root, qualificationArguments(root, bufExecutable));
  const compatibleCheck = JSON.parse((await runCli(root, [
      "check",
      "contract.protobuf-evolution",
      "--consumer",
      root,
      "--format",
      "json"
  ])).stdout);
  if (compatibleCheck.outcome !== "passed") {
    throw new Error("Qualified compatible evidence did not pass the normal capability.");
  }
}

async function assertBreakingQualification(root, bufExecutable, bufConfigDigest) {
  await writeFile(
    join(root, "contracts", "protobuf", "control.proto"),
    'syntax = "proto3";\npackage qualification.v1;\nmessage Control {\n  string renamed = 1;\n}\n',
    "utf8"
  );
  const candidateBytes = await buildDescriptor(bufExecutable, root, "candidate.binpb");
  await writeJson(
    join(root, "architecture", "foundation", "protobuf-evolution.yaml"),
    protobufConfig({
      publicContractVersion: "2.0.0",
      bufConfigDigest,
      descriptorImageDigest: sha256(candidateBytes),
      generatedOutputDigest: sha256("generated-v2")
    })
  );
  const writeBreaking = JSON.parse((await runCli(
    root,
    qualificationArguments(root, bufExecutable, true)
  )).stdout);
  if (writeBreaking.qualification?.status !== "breaking") {
    throw new Error("Real Buf breaking qualification did not preserve exit code 100 semantics.");
  }
  const evidencePath = join(root, "architecture", "evidence", "protobuf", "control.json");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  if (
    evidence.policy !== "FILE" ||
    evidence.result?.findings?.some((finding) => typeof finding.type !== "string") !== false ||
    evidence.result.findings.length === 0
  ) {
    throw new Error("Real Buf evidence did not contain normalized FILE findings.");
  }
  const normalBreakingCheck = JSON.parse((await runCli(root, [
      "check",
      "contract.protobuf-evolution",
      "--consumer",
      root,
      "--format",
      "json"
  ], [0, 1])).stdout);
  if (
    normalBreakingCheck.outcome !== "violations" ||
    normalBreakingCheck.capabilities?.[0]?.diagnostics?.[0]?.ruleId !==
      "contract.protobuf-evolution.breaking-change-not-approved"
  ) {
    throw new Error("Normal capability did not require approval for real breaking evidence.");
  }

  evidence.result.rawOutputDigest = `sha256:${"f".repeat(64)}`;
  await writeJson(evidencePath, evidence);
  const fabricated = await runCli(
    root,
    qualificationArguments(root, bufExecutable),
    [0, 2]
  );
  const fabricatedError = fabricated.stdout.length === 0
    ? undefined
    : JSON.parse(fabricated.stdout);
  if (
    fabricated.exitCode !== 2 ||
    fabricated.stderr !== "" ||
    fabricatedError?.error?.code !== "BUF_QUALIFICATION_EVIDENCE_MISMATCH"
  ) {
    throw new Error("Qualifier accepted fabricated evidence instead of rerunning Buf.");
  }
}

async function main() {
  const bufExecutable = await resolvePinnedBuf();
  const root = await mkdtemp(join(tmpdir(), "agent-teams-buf-e2e-"));
  try {
    const bufConfigDigest = await writeInitialFixture(root, bufExecutable);
    await assertCompatibleQualification(root, bufExecutable);
    await assertBreakingQualification(root, bufExecutable, bufConfigDigest);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
  process.stdout.write(`Pinned Buf ${bufVersion} FILE qualification E2E passed.\n`);
}

await main();
