import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function verifyPackedEffectiveInstructions({ consumerRoot, runPnpm }) {
  await writeFile(
    join(consumerRoot, "src", "AGENTS.override.md"),
    "# Packed source instructions\n",
    "utf8",
  );
  const { stdout } = await runPnpm(
    [
      "--silent",
      "exec",
      "agent-teams-foundation",
      "agent-workflow",
      "instructions",
      "src/index.ts",
      "--consumer",
      consumerRoot,
      "--format",
      "json",
    ],
    consumerRoot,
  );
  const report = JSON.parse(stdout);
  if (
    report.outcome !== "resolved" ||
    report.target?.path !== "src/index.ts" ||
    report.layers?.map(({ selectedPath }) => selectedPath).join(",") !==
      "AGENTS.md,src/AGENTS.override.md" ||
    !/^sha256:[a-f0-9]{64}$/u.test(report.resolutionDigest)
  ) {
    throw new Error("Packed effective-instructions workflow did not resolve end to end.");
  }
}

export async function testPackedAgentWorkflow({
  consumerRoot,
  runPnpm,
}) {
  const manifestPath = join(consumerRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.scripts = {
    "check:changed": "agent-teams-foundation agent-workflow changed --consumer .",
    "check:fast": "node scripts/record-agent-check.mjs fast",
    check: "node scripts/record-agent-check.mjs full",
    "lint:fast:files": "node scripts/record-agent-check.mjs lint",
    typecheck: "node scripts/record-agent-check.mjs typecheck",
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const foundationConfigPath = join(consumerRoot, "foundation.config.yaml");
  await writeFile(
    foundationConfigPath,
    `${await readFile(foundationConfigPath, "utf8")}  repository.agent-workflow:\n    configPath: architecture/foundation/repository-agent-workflow.yaml\n`,
    "utf8",
  );
  await writeFile(
    join(consumerRoot, "architecture", "foundation", "repository-agent-workflow.yaml"),
    `schemaVersion: 1
instructions:
  canonical: AGENTS.md
  claude: CLAUDE.md
  gemini: GEMINI.md
  copilot: .github/copilot-instructions.md
scripts:
  changed: check:changed
  fast: check:fast
  full: check
changedChecks:
  - id: lint
    script: lint:fast:files
    extensions: [.ts]
  - id: typecheck
    script: typecheck
    extensions: [.ts]
    passPaths: false
fullScanPaths:
  - pnpm-lock.yaml
`,
    "utf8",
  );
  await mkdir(join(consumerRoot, ".github"), { recursive: true });
  await mkdir(join(consumerRoot, "scripts"), { recursive: true });
  await writeFile(
    join(consumerRoot, "AGENTS.md"),
    "Run `pnpm check:changed`, `pnpm check:fast`, and `pnpm check`.\n",
    "utf8",
  );
  await writeFile(join(consumerRoot, "CLAUDE.md"), "@AGENTS.md\n", "utf8");
  await writeFile(join(consumerRoot, "GEMINI.md"), "@AGENTS.md\n", "utf8");
  await writeFile(
    join(consumerRoot, ".github", "copilot-instructions.md"),
    "Read and follow AGENTS.md before editing.\n",
    "utf8",
  );
  await writeFile(
    join(consumerRoot, ".gitignore"),
    "node_modules\n.agent-workflow-invocations.jsonl\n",
    "utf8",
  );
  await writeFile(
    join(consumerRoot, "scripts", "record-agent-check.mjs"),
    `import { appendFile } from "node:fs/promises";
const [kind, ...rawPaths] = process.argv.slice(2);
const paths = rawPaths[0] === "--" ? rawPaths.slice(1) : rawPaths;
await appendFile(".agent-workflow-invocations.jsonl", JSON.stringify({ kind, paths }) + "\\n");
`,
    "utf8",
  );

  const { stdout: capabilityOutput } = await runPnpm(
    [
      "--silent",
      "exec",
      "agent-teams-foundation",
      "check",
      "repository.agent-workflow",
      "--consumer",
      consumerRoot,
      "--format",
      "json",
    ],
    consumerRoot,
  );
  if (JSON.parse(capabilityOutput).outcome !== "passed") {
    throw new Error("Packed agent workflow capability did not pass.");
  }

  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.email", "fixture@agent-teams.invalid"],
    ["config", "user.name", "Packed fixture"],
    ["add", "--all"],
    ["add", "--force", "CLAUDE.md"],
    ["commit", "--message", "test: initialize packed consumer"],
  ]) {
    await execFileAsync("git", args, { cwd: consumerRoot });
  }
  await writeFile(
    join(consumerRoot, "src", "index.ts"),
    "export const packedAgentWorkflow = true;\n",
    "utf8",
  );
  await verifyPackedEffectiveInstructions({ consumerRoot, runPnpm });
  const { stdout: workflowOutput } = await runPnpm(
    [
      "--silent",
      "exec",
      "agent-teams-foundation",
      "agent-workflow",
      "changed",
      "--base",
      "HEAD",
      "--consumer",
      consumerRoot,
      "--format",
      "json",
    ],
    consumerRoot,
  );
  const workflow = JSON.parse(workflowOutput);
  if (
    workflow.outcome !== "passed" ||
    workflow.coverage !== "changed" ||
    workflow.steps?.map(({ id }) => id).join(",") !== "lint,typecheck"
  ) {
    throw new Error("Packed changed-file workflow did not pass end to end.");
  }
  const invocations = (await readFile(
    join(consumerRoot, ".agent-workflow-invocations.jsonl"),
    "utf8",
  )).trim().split("\n").map((line) => JSON.parse(line));
  if (
    JSON.stringify(invocations) !==
    JSON.stringify([
      { kind: "lint", paths: ["src/index.ts"] },
      { kind: "typecheck", paths: [] },
    ])
  ) {
    throw new Error("Packed workflow did not preserve changed-file arguments.");
  }
}
