/* oxlint-disable max-lines -- changed-scope routing and Git evidence share one end-to-end contract matrix. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  check,
  cliPath,
  withAgentWorkflowFixture,
} from "./support/capability-fixtures.mjs";
import {
  sha256Bytes,
  sha256Json,
} from "../packages/engineering-foundation/dist/canonical-json.js";
import { PnpmPackageScriptRunner } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/pnpm/pnpm-package-script-runner.js";
import { FilesystemEffectiveInstructionsReader } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/filesystem/filesystem-effective-instructions-reader.js";
import { resolveEffectiveInstructions } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/application/use-cases/resolve-effective-instructions.js";

const instructionSemantics =
  "foundation-safe-codex-default-project-instructions-v1";
const instructionBudgetBytes = 32 * 1024;

function instructionFile(path, bytes) {
  return Object.freeze({
    kind: "file",
    path,
    sourceBytes: bytes.byteLength,
    bytes,
  });
}

function unreadInstructionFile(path, sourceBytes) {
  return Object.freeze({
    kind: "file",
    path,
    sourceBytes,
    bytes: null,
  });
}

function instructionReader({ targetPath, directories, observations, reads = [] }) {
  return {
    async discover() {
      return Object.freeze({
        targetPath,
        targetDirectory: "src",
        directories: Object.freeze([...directories]),
      });
    },
    async readDirectory(input) {
      reads.push(Object.freeze({
        directory: input.directory,
        readSelectedBytes: input.readSelectedBytes,
      }));
      const candidates = observations.get(input.directory);
      assert.notEqual(candidates, undefined);
      return Object.freeze({
        directory: input.directory,
        candidates,
      });
    },
  };
}

function expectedResolutionDigest(targetPath, sources) {
  return sha256Json({
    semantics: instructionSemantics,
    sources: sources.map(({ path, bytes }) => ({
      path,
      loadedBytes: bytes.byteLength,
      loadedDigest: sha256Bytes(bytes),
    })),
    targetPath,
  });
}

function git(consumerRoot, ...args) {
  const result = spawnSync("git", args, { cwd: consumerRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function gitOutput(consumerRoot, ...args) {
  const result = spawnSync("git", args, { cwd: consumerRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function initializeRepository(consumerRoot) {
  git(consumerRoot, "init", "--initial-branch=main");
  git(consumerRoot, "config", "user.email", "fixture@agent-teams.invalid");
  git(consumerRoot, "config", "user.name", "Foundation fixture");
  git(consumerRoot, "add", "--all");
  git(consumerRoot, "commit", "--message", "test: initialize fixture");
}

function runChanged(consumerRoot, ...args) {
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "agent-workflow",
      "changed",
      "--base",
      "HEAD",
      "--consumer",
      consumerRoot,
      "--format",
      "json",
      ...args,
    ],
    { encoding: "utf8" },
  );
  return {
    result,
    report: result.stdout.length === 0 ? null : JSON.parse(result.stdout),
  };
}

function runChangedAuto(consumerRoot) {
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "agent-workflow",
      "changed",
      "--consumer",
      consumerRoot,
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  );
  return {
    result,
    report: result.stdout.length === 0 ? null : JSON.parse(result.stdout),
  };
}

function runInstructions(consumerRoot, targetPath, format = "json", ...args) {
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "agent-workflow",
      "instructions",
      targetPath,
      "--consumer",
      consumerRoot,
      "--format",
      format,
      ...args,
    ],
    { encoding: "utf8" },
  );
  return {
    result,
    report: format === "json" && result.stdout.length > 0
      ? JSON.parse(result.stdout)
      : null,
  };
}

function runAgentWorkflowRaw(...args) {
  const result = spawnSync(
    process.execPath,
    [cliPath, "agent-workflow", ...args, "--format", "json"],
    { encoding: "utf8" },
  );
  return { result, report: JSON.parse(result.stdout) };
}

async function invocations(consumerRoot) {
  const source = await readFile(
    join(consumerRoot, ".fixture-invocations.jsonl"),
    "utf8",
  );
  return source.trim().split("\n").map((line) => JSON.parse(line));
}

async function waitForProcessId(path) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const pid = Number.parseInt(await readFile(path, "utf8"), 10);
      if (Number.isSafeInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // The producer may not have created the synchronization file yet.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`Timed out waiting for a process ID in ${path}.`);
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("accepts one canonical instruction source with portable adapters", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 0);
    assert.equal(report.outcome, "passed");
    assert.equal(report.capabilities[0].capabilityId, "repository.agent-workflow");
  });
});

test("resolves effective instructions root-to-target with explicit shadowing", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "src", "AGENTS.md"),
      "x".repeat(300_000),
      "utf8",
    );
    await writeFile(
      join(consumerRoot, "src", "AGENTS.override.md"),
      "# Effective source instructions\n",
      "utf8",
    );

    const { result, report } = runInstructions(consumerRoot, "src/index.ts");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.outcome, "resolved");
    assert.equal(
      report.semantics,
      "foundation-safe-codex-default-project-instructions-v1",
    );
    assert.deepEqual(
      report.layers.map((layer) => ({
        path: layer.selectedPath,
        scope: layer.scope,
        status: layer.status,
        canOverrideEarlier: layer.canOverrideEarlier,
        shadowed: layer.shadowed.map(({ path }) => path),
      })),
      [
        {
          path: "AGENTS.md",
          scope: "**/*",
          status: "applied",
          canOverrideEarlier: [],
          shadowed: [],
        },
        {
          path: "src/AGENTS.override.md",
          scope: "src/**/*",
          status: "applied",
          canOverrideEarlier: ["AGENTS.md"],
          shadowed: ["src/AGENTS.md"],
        },
      ],
    );
    assert.match(report.resolutionDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(
      report.budget.loadedBytes,
      Buffer.byteLength(await readFile(join(consumerRoot, "AGENTS.md"), "utf8")) +
        Buffer.byteLength("# Effective source instructions\n"),
    );
    assert.equal(report.layers[0].sourceBytes, report.layers[0].loadedBytes);
    assert.equal(report.layers[1].sourceBytes, report.layers[1].loadedBytes);
    const repeated = runInstructions(consumerRoot, "src/index.ts").report;
    assert.equal(repeated.resolutionDigest, report.resolutionDigest);

    await writeFile(join(consumerRoot, "src", "AGENTS.md"), "y".repeat(300_000));
    const shadowChanged = runInstructions(consumerRoot, "src/index.ts").report;
    assert.equal(shadowChanged.resolutionDigest, report.resolutionDigest);

    await writeFile(
      join(consumerRoot, "src", "AGENTS.override.md"),
      "# Changed effective source instructions\n",
    );
    const admittedChanged = runInstructions(consumerRoot, "src/index.ts").report;
    assert.notEqual(admittedChanged.resolutionDigest, report.resolutionDigest);
    const targetChanged = runInstructions(consumerRoot, "src/planned.ts").report;
    assert.notEqual(targetChanged.resolutionDigest, admittedChanged.resolutionDigest);

    const text = runInstructions(consumerRoot, "src/index.ts", "text").result;
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Effective instructions for src\/index\.ts/u);
    assert.match(text.stdout, /Shadowed: src\/AGENTS\.md/u);
  });
});

test("binds the resolution digest only to ordered admitted bytes and target path", async () => {
  const encoder = new TextEncoder();
  const rootBytes = encoder.encode("# Root instructions\n");
  const sourceBytes = encoder.encode("# Source instructions\n");
  const changedSourceBytes = encoder.encode("# Changed source instructions\n");

  async function resolve({
    targetPath = "src/index.ts",
    admittedBytes = sourceBytes,
    shadowedBytes = 91,
  } = {}) {
    const observations = new Map([
      [
        ".",
        Object.freeze([
          Object.freeze({ kind: "missing", path: "AGENTS.override.md" }),
          instructionFile("AGENTS.md", rootBytes),
        ]),
      ],
      [
        "src",
        Object.freeze([
          instructionFile("src/AGENTS.override.md", admittedBytes),
          unreadInstructionFile("src/AGENTS.md", shadowedBytes),
        ]),
      ],
    ]);
    return await resolveEffectiveInstructions(
      { consumerRoot: "/disposable-fixture", targetPath },
      instructionReader({
        targetPath,
        directories: [".", "src"],
        observations,
      }),
    );
  }

  const first = await resolve();
  const repeated = await resolve();
  assert.equal(first.resolutionDigest, repeated.resolutionDigest);
  assert.equal(
    first.resolutionDigest,
    expectedResolutionDigest("src/index.ts", [
      { path: "AGENTS.md", bytes: rootBytes },
      { path: "src/AGENTS.override.md", bytes: sourceBytes },
    ]),
  );

  const shadowedChanged = await resolve({ shadowedBytes: 8_192 });
  assert.equal(shadowedChanged.resolutionDigest, first.resolutionDigest);
  assert.equal(shadowedChanged.layers[1].shadowed[0].path, "src/AGENTS.md");

  const admittedChanged = await resolve({ admittedBytes: changedSourceBytes });
  assert.notEqual(admittedChanged.resolutionDigest, first.resolutionDigest);
  assert.equal(
    admittedChanged.resolutionDigest,
    expectedResolutionDigest("src/index.ts", [
      { path: "AGENTS.md", bytes: rootBytes },
      { path: "src/AGENTS.override.md", bytes: changedSourceBytes },
    ]),
  );

  const targetChanged = await resolve({ targetPath: "src/planned.ts" });
  assert.notEqual(targetChanged.resolutionDigest, first.resolutionDigest);
  assert.equal(
    targetChanged.resolutionDigest,
    expectedResolutionDigest("src/planned.ts", [
      { path: "AGENTS.md", bytes: rootBytes },
      { path: "src/AGENTS.override.md", bytes: sourceBytes },
    ]),
  );
});

test("stops reading instruction content at the exact byte boundary but retains metadata", async () => {
  const boundaryBytes = new TextEncoder().encode("r".repeat(instructionBudgetBytes));
  const reads = [];
  const observations = new Map([
    [
      ".",
      Object.freeze([
        Object.freeze({ kind: "missing", path: "AGENTS.override.md" }),
        instructionFile("AGENTS.md", boundaryBytes),
      ]),
    ],
    [
      "src",
      Object.freeze([
        Object.freeze({ kind: "missing", path: "src/AGENTS.override.md" }),
        unreadInstructionFile("src/AGENTS.md", 400_000),
      ]),
    ],
  ]);
  const report = await resolveEffectiveInstructions(
    { consumerRoot: "/disposable-fixture", targetPath: "src/index.ts" },
    instructionReader({
      targetPath: "src/index.ts",
      directories: [".", "src"],
      observations,
      reads,
    }),
  );

  assert.deepEqual(reads, [
    { directory: ".", readSelectedBytes: true },
    { directory: "src", readSelectedBytes: false },
  ]);
  assert.deepEqual(report.budget, {
    maximumBytes: instructionBudgetBytes,
    loadedBytes: instructionBudgetBytes,
    exhausted: true,
    truncated: false,
  });
  assert.deepEqual(
    report.layers.map((layer) => ({
      selectedPath: layer.selectedPath,
      status: layer.status,
      sourceBytes: layer.sourceBytes,
      loadedBytes: layer.loadedBytes,
      sourceDigest: layer.sourceDigest,
    })),
    [
      {
        selectedPath: "AGENTS.md",
        status: "applied",
        sourceBytes: instructionBudgetBytes,
        loadedBytes: instructionBudgetBytes,
        sourceDigest: sha256Bytes(boundaryBytes),
      },
      {
        selectedPath: "src/AGENTS.md",
        status: "budget-exhausted",
        sourceBytes: 400_000,
        loadedBytes: 0,
        sourceDigest: null,
      },
    ],
  );
  assert.equal(
    report.resolutionDigest,
    expectedResolutionDigest("src/index.ts", [
      { path: "AGENTS.md", bytes: boundaryBytes },
    ]),
  );
});

test("truncates exactly one byte beyond the instruction budget", async () => {
  const source = new TextEncoder().encode(
    `${"a".repeat(instructionBudgetBytes)}z`,
  );
  const admitted = source.slice(0, instructionBudgetBytes);
  const observations = new Map([
    [
      ".",
      Object.freeze([
        Object.freeze({ kind: "missing", path: "AGENTS.override.md" }),
        instructionFile("AGENTS.md", source),
      ]),
    ],
  ]);
  const report = await resolveEffectiveInstructions(
    { consumerRoot: "/disposable-fixture", targetPath: "src/index.ts" },
    instructionReader({
      targetPath: "src/index.ts",
      directories: ["."],
      observations,
    }),
  );

  assert.deepEqual(report.budget, {
    maximumBytes: instructionBudgetBytes,
    loadedBytes: instructionBudgetBytes,
    exhausted: true,
    truncated: true,
  });
  assert.equal(report.layers[0].status, "truncated");
  assert.equal(report.layers[0].sourceBytes, instructionBudgetBytes + 1);
  assert.equal(report.layers[0].loadedBytes, instructionBudgetBytes);
  assert.equal(report.layers[0].sourceDigest, sha256Bytes(source));
  assert.equal(report.layers[0].loadedDigest, sha256Bytes(admitted));
  assert.equal(
    report.resolutionDigest,
    expectedResolutionDigest("src/index.ts", [
      { path: "AGENTS.md", bytes: admitted },
    ]),
  );
});

test("reports an empty override that masks the canonical file without consuming budget", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    await writeFile(join(consumerRoot, "src", "AGENTS.md"), "# Hidden\n", "utf8");
    await writeFile(join(consumerRoot, "src", "AGENTS.override.md"), " \n\t", "utf8");

    const { result, report } = runInstructions(consumerRoot, "src/index.ts");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.layers[1].status, "ignored-empty");
    assert.equal(report.layers[1].loadedBytes, 0);
    assert.deepEqual(report.layers[1].shadowed.map(({ path }) => path), [
      "src/AGENTS.md",
    ]);
    assert.deepEqual(report.layers[1].canOverrideEarlier, []);
  });
});

test("shows truncation and later exclusions at the default instruction byte budget", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    await mkdir(join(consumerRoot, "src", "nested"));
    await writeFile(join(consumerRoot, "AGENTS.md"), "r".repeat(32_760), "utf8");
    await writeFile(join(consumerRoot, "src", "AGENTS.md"), "s".repeat(20), "utf8");
    await writeFile(
      join(consumerRoot, "src", "nested", "AGENTS.md"),
      "n".repeat(300_000),
      "utf8",
    );

    const { result, report } = runInstructions(
      consumerRoot,
      "src/nested/planned-file.ts",
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(report.budget, {
      maximumBytes: 32_768,
      loadedBytes: 32_768,
      exhausted: true,
      truncated: true,
    });
    assert.deepEqual(report.layers.map(({ status, loadedBytes }) => ({
      status,
      loadedBytes,
    })), [
      { status: "applied", loadedBytes: 32_760 },
      { status: "truncated", loadedBytes: 8 },
      { status: "budget-exhausted", loadedBytes: 0 },
    ]);
    assert.equal(report.layers[2].sourceBytes, 300_000);
    assert.equal(report.layers[2].sourceDigest, null);

    await writeFile(
      join(consumerRoot, "src", "AGENTS.md"),
      `${"s".repeat(8)}${"changed-after-budget".repeat(4)}`,
      "utf8",
    );
    const beyondBudgetChanged = runInstructions(
      consumerRoot,
      "src/nested/planned-file.ts",
    ).report;
    assert.equal(beyondBudgetChanged.resolutionDigest, report.resolutionDigest);
    assert.notEqual(
      beyondBudgetChanged.layers[1].sourceDigest,
      report.layers[1].sourceDigest,
    );
  });
});

test("rejects unsafe effective-instruction targets and selected symlinks", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    const escaped = runInstructions(consumerRoot, "../outside.ts");
    assert.equal(escaped.result.status, 2);
    assert.equal(escaped.report.error.code, "CONFIG_PATH_INVALID");

    const changedOnlyOption = runInstructions(
      consumerRoot,
      "src/index.ts",
      "json",
      "--base",
      "HEAD",
    );
    assert.equal(changedOnlyOption.result.status, 2);
    assert.equal(changedOnlyOption.report.error.code, "CONSUMER_INVALID");
    assert.match(changedOnlyOption.report.error.message, /only by agent-workflow changed/u);

    const injected = runInstructions(consumerRoot, "src/evil\n\u001b[31m.ts");
    assert.equal(injected.result.status, 2);
    assert.equal(
      injected.report.error.code,
      "REPOSITORY_AGENT_WORKFLOW_TARGET_PATH_INVALID",
    );

    const reader = new FilesystemEffectiveInstructionsReader();
    const unavailableRoot = join(consumerRoot, "does-not-exist");
    const unsafeDisplayCharacters = [
      ["NUL", "\u0000"],
      ["newline", "\n"],
      ["carriage return", "\r"],
      ["ANSI escape", "\u001b"],
      ["DEL", "\u007f"],
      ["C1 next line", "\u0085"],
      ["C1 control sequence introducer", "\u009b"],
      ["Unicode line separator", "\u2028"],
      ["Unicode paragraph separator", "\u2029"],
    ];
    for (const [name, character] of unsafeDisplayCharacters) {
      await assert.rejects(
        reader.discover({
          consumerRoot: unavailableRoot,
          targetPath: `src/${character}spoofed.ts`,
        }),
        (error) => {
          assert.equal(
            error.problem?.code,
            "REPOSITORY_AGENT_WORKFLOW_TARGET_PATH_INVALID",
            name,
          );
          assert.doesNotMatch(error.message, /spoofed/u, name);
          return true;
        },
      );
    }

    const directory = runInstructions(consumerRoot, "src");
    assert.equal(directory.result.status, 2);
    assert.equal(
      directory.report.error.code,
      "REPOSITORY_AGENT_WORKFLOW_TARGET_INVALID",
    );

    const missingTarget = runAgentWorkflowRaw(
      "instructions",
      "--consumer",
      unavailableRoot,
    );
    assert.equal(missingTarget.result.status, 2);
    assert.match(
      missingTarget.report.error.message,
      /requires exactly one repository-relative file/u,
    );
    const extraTarget = runAgentWorkflowRaw(
      "instructions",
      "src/index.ts",
      "src/other.ts",
      "--consumer",
      unavailableRoot,
    );
    assert.equal(extraTarget.result.status, 2);
    assert.match(
      extraTarget.report.error.message,
      /accepts at most 2 positional arguments/u,
    );
    const extraChangedTarget = runAgentWorkflowRaw(
      "changed",
      "src/index.ts",
      "--consumer",
      unavailableRoot,
    );
    assert.equal(extraChangedTarget.result.status, 2);
    assert.match(extraChangedTarget.report.error.message, /does not accept a target path/u);

    if (process.platform !== "win32") {
      await symlink("../AGENTS.md", join(consumerRoot, "src", "AGENTS.override.md"));
      const linked = runInstructions(consumerRoot, "src/index.ts");
      assert.equal(linked.result.status, 2);
      assert.equal(
        linked.report.error.code,
        "REPOSITORY_AGENT_WORKFLOW_INSTRUCTION_SYMLINK_PROHIBITED",
      );
    }
  });
});

test("executes pnpm through its shell-free package entrypoint", async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), "foundation-pnpm-entrypoint-"));
  try {
    const pnpmHome = join(consumerRoot, "node_modules", ".bin");
    const pnpmPackageRoot = join(consumerRoot, "node_modules", "pnpm", "bin");
    await mkdir(pnpmHome, { recursive: true });
    await mkdir(pnpmPackageRoot, { recursive: true });
    await writeFile(
      join(pnpmPackageRoot, "pnpm.cjs"),
      `require("node:fs").writeFileSync(".fake-pnpm-args.json", JSON.stringify(process.argv.slice(2)));\n`,
      "utf8",
    );
    const result = await new PnpmPackageScriptRunner({ pnpmHome }).run({
      consumerRoot,
      script: "lint:files",
      paths: ["src/file with space.ts"],
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      JSON.parse(await readFile(join(consumerRoot, ".fake-pnpm-args.json"), "utf8")),
      ["run", "lint:files", "--", "src/file with space.ts"],
    );
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
});

test("SIGTERM cancels the changed workflow and its retained process tree", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withAgentWorkflowFixture(async (consumerRoot) => {
    const manifestPath = join(consumerRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.scripts["lint:fast:files"] = "node scripts/never-exit.mjs";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(
      join(consumerRoot, "scripts", "never-exit.mjs"),
      `import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore"
});
descendant.once("exit", () => process.exit());
await writeFile(".fixture-descendant.pid", String(descendant.pid));
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    initializeRepository(consumerRoot);
    await writeFile(join(consumerRoot, "src", "index.ts"), "export const fixture = false;\n");

    const command = spawn(
      process.execPath,
      [
        cliPath,
        "agent-workflow",
        "changed",
        "--base",
        "HEAD",
        "--consumer",
        consumerRoot,
        "--format",
        "json",
      ],
      { encoding: "utf8" },
    );
    let stdout = "";
    command.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    let stderr = "";
    command.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let descendantPid;
    try {
      descendantPid = await waitForProcessId(
        join(consumerRoot, ".fixture-descendant.pid"),
      );
      const closed = new Promise((resolve) => {
        command.once("close", resolve);
      });
      assert.equal(command.kill("SIGTERM"), true);
      const exitCode = await closed;
      for (let attempt = 0; attempt < 100 && processIsRunning(descendantPid); attempt += 1) {
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }

      assert.equal(exitCode, 130, stderr);
      assert.equal(stderr, "");
      assert.equal(JSON.parse(stdout).error.code, "PROCESS_CANCELLED");
      assert.equal(processIsRunning(descendantPid), false);
    } finally {
      if (descendantPid !== undefined && processIsRunning(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      if (command.exitCode === null && command.signalCode === null) {
        command.kill("SIGKILL");
      }
    }
  });
});

test("reports broken adapters, undocumented commands, and missing scripts", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    await rm(join(consumerRoot, "CLAUDE.md"));
    await writeFile(
      join(consumerRoot, "GEMINI.md"),
      "# Detached instructions mention @AGENTS.md without importing it\n",
      "utf8",
    );
    await writeFile(join(consumerRoot, "AGENTS.md"), "# Incomplete instructions\n", "utf8");
    const manifestPath = join(consumerRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.scripts.typecheck;
    manifest.scripts["check:changed"] = "node scripts/record-check.mjs changed";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      new Set(report.capabilities[0].diagnostics.map(({ ruleId }) => ruleId)),
      new Set([
        "repository.agent-workflow.adapter-not-linked",
        "repository.agent-workflow.changed-runner-invalid",
        "repository.agent-workflow.command-not-documented",
        "repository.agent-workflow.instruction-file-invalid",
        "repository.agent-workflow.package-script-missing",
      ]),
    );
  });
});

test("rejects instruction adapters that are symbolic links", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withAgentWorkflowFixture(async (consumerRoot) => {
    const adapterPath = join(consumerRoot, "CLAUDE.md");
    const targetPath = join(consumerRoot, "CLAUDE.real.md");
    await rename(adapterPath, targetPath);
    await symlink(targetPath, adapterPath);
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1);
    assert.equal(
      report.capabilities[0].diagnostics.some(
        ({ ruleId }) => ruleId === "repository.agent-workflow.instruction-file-invalid",
      ),
      true,
    );
  });
});

test("rejects one file being assigned to multiple instruction roles", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    const configPath = join(
      consumerRoot,
      "architecture",
      "foundation",
      "repository-agent-workflow.yaml",
    );
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source.replace("claude: CLAUDE.md", "claude: AGENTS.md"),
      "utf8",
    );
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(
      report.capabilities[0].problem.code,
      "REPOSITORY_AGENT_WORKFLOW_CONFIG_INVALID",
    );
  });
});

test("does not run package scripts when the Git delta is empty", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.outcome, "passed");
    assert.equal(report.coverage, "changed");
    assert.deepEqual(report.changedPaths, []);
    assert.deepEqual(report.steps, []);
    assert.equal(report.requestedBaseRef, "HEAD");
    assert.equal(report.resolvedBaseRef, "HEAD");
    assert.equal(report.baseCommit, report.headCommit);
    assert.equal(report.mergeBaseCommit, report.headCommit);
    assert.match(report.scopeDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(report.changeGroups, {
      committed: { paths: [], deletedPaths: [] },
      staged: { paths: [], deletedPaths: [] },
      unstaged: { paths: [], deletedPaths: [] },
      untracked: { paths: [], deletedPaths: [] },
    });
  });
});

test("reports committed, staged, unstaged, and untracked evidence without changing routing", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    for (const name of ["committed.ts", "staged.ts", "unstaged.ts"]) {
      await writeFile(join(consumerRoot, "src", name), "export const value = 0;\n");
    }
    initializeRepository(consumerRoot);
    const baseCommit = gitOutput(consumerRoot, "rev-parse", "HEAD");

    await writeFile(join(consumerRoot, "src", "committed.ts"), "export const value = 1;\n");
    git(consumerRoot, "add", "--", "src/committed.ts");
    git(consumerRoot, "commit", "--message", "test: committed evidence");
    await writeFile(join(consumerRoot, "src", "staged.ts"), "export const value = 2;\n");
    git(consumerRoot, "add", "--", "src/staged.ts");
    await writeFile(join(consumerRoot, "src", "unstaged.ts"), "export const value = 3;\n");
    await writeFile(join(consumerRoot, "src", "untracked.ts"), "export const value = 4;\n");

    const { result, report } = runChanged(consumerRoot, "--base", baseCommit);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.coverage, "changed");
    assert.equal(report.requestedBaseRef, baseCommit);
    assert.equal(report.resolvedBaseRef, baseCommit);
    assert.equal(report.baseCommit, baseCommit);
    assert.equal(report.mergeBaseCommit, baseCommit);
    assert.deepEqual(report.changeGroups, {
      committed: { paths: ["src/committed.ts"], deletedPaths: [] },
      staged: { paths: ["src/staged.ts"], deletedPaths: [] },
      unstaged: { paths: ["src/unstaged.ts"], deletedPaths: [] },
      untracked: { paths: ["src/untracked.ts"], deletedPaths: [] },
    });
    assert.deepEqual(report.changedPaths, [
      "src/committed.ts",
      "src/staged.ts",
      "src/unstaged.ts",
      "src/untracked.ts",
    ]);
  });
});

test("produces a deterministic empty-scope digest and does not mutate the repository", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const indexPath = join(consumerRoot, ".git", "index");
    const indexBefore = await readFile(indexPath);
    const statusBefore = gitOutput(consumerRoot, "status", "--porcelain=v2", "-z");

    const first = runChanged(consumerRoot);
    const second = runChanged(consumerRoot);

    assert.equal(first.result.status, 0, first.result.stderr);
    assert.equal(second.result.status, 0, second.result.stderr);
    assert.equal(second.report.scopeDigest, first.report.scopeDigest);
    assert.deepEqual(await readFile(indexPath), indexBefore);
    assert.equal(
      gitOutput(consumerRoot, "status", "--porcelain=v2", "-z"),
      statusBefore,
    );
  });
});

test("auto base reports the resolved ref separately from its merge base", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const initial = gitOutput(consumerRoot, "rev-parse", "HEAD");
    await writeFile(join(consumerRoot, "src", "index.ts"), "export const fixture = false;\n");
    git(consumerRoot, "add", "--", "src/index.ts");
    git(consumerRoot, "commit", "--message", "test: advance head");

    const { result, report } = runChangedAuto(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.requestedBaseRef, null);
    assert.equal(report.resolvedBaseRef, "refs/heads/main");
    assert.equal(report.baseCommit, report.headCommit);
    assert.equal(report.mergeBaseCommit, report.headCommit);
    assert.notEqual(report.headCommit, initial);
  });
});

test("auto base preserves committed scope from a detached head", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const baseCommit = gitOutput(consumerRoot, "rev-parse", "HEAD");
    await writeFile(join(consumerRoot, "src", "index.ts"), "export const fixture = false;\n");
    git(consumerRoot, "add", "--", "src/index.ts");
    git(consumerRoot, "commit", "--message", "test: detached change");
    const headCommit = gitOutput(consumerRoot, "rev-parse", "HEAD");
    git(consumerRoot, "update-ref", "refs/remotes/origin/main", baseCommit);
    git(consumerRoot, "checkout", "--detach", headCommit);
    git(consumerRoot, "branch", "--delete", "--force", "main");

    const { result, report } = runChangedAuto(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.resolvedBaseRef, "refs/remotes/origin/main");
    assert.equal(report.baseCommit, baseCommit);
    assert.equal(report.headCommit, headCommit);
    assert.equal(report.mergeBaseCommit, baseCommit);
    assert.deepEqual(report.changeGroups.committed.paths, ["src/index.ts"]);
  });
});

test("ignores local replacement objects when deriving immutable Git evidence", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const baseCommit = gitOutput(consumerRoot, "rev-parse", "HEAD");
    await writeFile(join(consumerRoot, "src", "index.ts"), "export const fixture = false;\n");
    git(consumerRoot, "add", "--", "src/index.ts");
    git(consumerRoot, "commit", "--message", "test: replacement target");
    const headCommit = gitOutput(consumerRoot, "rev-parse", "HEAD");
    git(consumerRoot, "update-ref", "refs/remotes/origin/main", baseCommit);
    git(consumerRoot, "checkout", "--detach", headCommit);
    git(consumerRoot, "branch", "--delete", "--force", "main");
    git(consumerRoot, "replace", headCommit, baseCommit);

    const { result, report } = runChangedAuto(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.headCommit, headCommit);
    assert.equal(report.mergeBaseCommit, baseCommit);
    assert.deepEqual(report.changeGroups.committed.paths, ["src/index.ts"]);
  });
});

test("fails closed when an auto base is present but shallow history hides its merge base", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const baseCommit = gitOutput(consumerRoot, "rev-parse", "HEAD");
    await writeFile(join(consumerRoot, "src", "index.ts"), "export const fixture = false;\n");
    git(consumerRoot, "add", "--", "src/index.ts");
    git(consumerRoot, "commit", "--message", "test: shallow head");
    const headCommit = gitOutput(consumerRoot, "rev-parse", "HEAD");
    git(consumerRoot, "update-ref", "refs/remotes/origin/main", baseCommit);
    git(consumerRoot, "checkout", "--detach", headCommit);
    git(consumerRoot, "branch", "--delete", "--force", "main");
    await writeFile(join(consumerRoot, ".git", "shallow"), `${headCommit}\n`, "utf8");

    const { result, report } = runChangedAuto(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(report.error.code, "CONSUMER_INVALID");
    assert.match(report.error.message, /history may be shallow or unrelated/u);
  });
});

test("reports an unborn repository without inventing commit identities", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    git(consumerRoot, "init", "--initial-branch=main");
    const { result, report } = runChangedAuto(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.coverage, "fast-full");
    assert.equal(report.resolvedBaseRef, "unborn-head");
    assert.equal(report.baseCommit, null);
    assert.equal(report.headCommit, null);
    assert.equal(report.mergeBaseCommit, null);
    assert.equal(report.changeGroups.untracked.paths.includes("AGENTS.md"), true);
  });
});

test("routes changed source files to path-aware and project-wide checks", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    await writeFile(join(consumerRoot, "src", "index.ts"), "export const fixture = false;\n");
    await writeFile(join(consumerRoot, "src", "file with space.ts"), "export const spaced = true;\n");

    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.coverage, "changed");
    assert.deepEqual(
      report.steps.map(({ id, paths }) => ({ id, paths })),
      [
        {
          id: "lint",
          paths: ["src/file with space.ts", "src/index.ts"],
        },
        { id: "typecheck", paths: [] },
      ],
    );
    assert.deepEqual(await invocations(consumerRoot), [
      {
        kind: "lint",
        paths: ["src/file with space.ts", "src/index.ts"],
      },
      { kind: "typecheck", paths: [] },
    ]);
  });
});

test("matches configured multi-dot extensions", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    const configPath = join(
      consumerRoot,
      "architecture",
      "foundation",
      "repository-agent-workflow.yaml",
    );
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source.replace("extensions: [.js, .mjs, .ts, .tsx]", "extensions: [.d.ts]"),
      "utf8",
    );
    initializeRepository(consumerRoot);
    await writeFile(
      join(consumerRoot, "src", "public-api.d.ts"),
      "export declare const publicApi: true;\n",
      "utf8",
    );

    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      report.steps.map(({ id, paths }) => ({ id, paths })),
      [
        { id: "lint", paths: ["src/public-api.d.ts"] },
        { id: "typecheck", paths: [] },
      ],
    );
  });
});

test("rejects a fast workflow that recursively invokes the changed workflow", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    const configPath = join(
      consumerRoot,
      "architecture",
      "foundation",
      "repository-agent-workflow.yaml",
    );
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source.replace("fast: check:fast", "fast: check:changed"),
      "utf8",
    );

    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(
      report.capabilities[0].problem.code,
      "REPOSITORY_AGENT_WORKFLOW_CONFIG_INVALID",
    );
    assert.match(
      report.capabilities[0].problem.message,
      /fast workflow script cannot be the changed workflow script/u,
    );
  });
});

test("escalates policy changes and deletions to the configured fast full gate", async () => {
  for (const mutate of [
    (consumerRoot) => writeFile(
      join(consumerRoot, "AGENTS.md"),
      "Run `pnpm check:changed`, `pnpm check:fast`, and `pnpm check`.\n",
      "utf8",
    ),
    (consumerRoot) => rm(join(consumerRoot, "src", "index.ts")),
  ]) {
    await withAgentWorkflowFixture(async (consumerRoot) => {
      initializeRepository(consumerRoot);
      await mutate(consumerRoot);
      const { result, report } = runChanged(consumerRoot);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(report.coverage, "fast-full");
      assert.deepEqual(
        report.steps.map(({ id, script, paths }) => ({ id, script, paths })),
        [{ id: "fast-full", script: "check:fast", paths: [] }],
      );
      assert.deepEqual(await invocations(consumerRoot), [{ kind: "fast", paths: [] }]);
    });
  }
});

test("treats a staged rename as deletion plus addition", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    await rename(
      join(consumerRoot, "src", "index.ts"),
      join(consumerRoot, "src", "renamed.ts"),
    );
    git(consumerRoot, "add", "--all");
    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.coverage, "fast-full");
    assert.deepEqual(report.changedPaths, ["src/index.ts", "src/renamed.ts"]);
    assert.deepEqual(await invocations(consumerRoot), [{ kind: "fast", paths: [] }]);
  });
});

test("does not let an untracked replacement mask a staged deletion", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    git(consumerRoot, "rm", "--cached", "src/index.ts");

    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.coverage, "fast-full");
    assert.deepEqual(report.changedPaths, ["src/index.ts"]);
    assert.deepEqual(report.changeGroups.staged, {
      paths: ["src/index.ts"],
      deletedPaths: ["src/index.ts"],
    });
    assert.deepEqual(report.changeGroups.untracked, {
      paths: ["src/index.ts"],
      deletedPaths: [],
    });
    assert.deepEqual(await invocations(consumerRoot), [{ kind: "fast", paths: [] }]);
  });
});

test("returns a stable violation result from a changed-file check", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    await writeFile(
      join(consumerRoot, "src", "index.ts"),
      "export const fixture = 'FAIL_FIXTURE';\n",
    );
    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 1);
    assert.equal(report.outcome, "violations");
    assert.equal(report.steps[0].outcome, "violations");
    assert.match(report.steps[0].output, /fixture violation: src\/index\.ts/u);
  });
});

test("escalates an oversized changed-file set instead of overflowing arguments", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    await Promise.all(
      Array.from({ length: 201 }, (_, index) =>
        writeFile(
          join(consumerRoot, "src", `generated-${String(index).padStart(3, "0")}.ts`),
          `export const generated${index} = ${index};\n`,
          "utf8",
        ),
      ),
    );
    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.changedPaths.length, 201);
    assert.equal(report.coverage, "fast-full");
    assert.deepEqual(await invocations(consumerRoot), [{ kind: "fast", paths: [] }]);
  });
});

test("rejects option-shaped Git base refs before invoking Git", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const { result, report } = runChanged(consumerRoot, "--base", "--malicious");
    assert.equal(result.status, 2);
    assert.equal(result.stderr, "");
    assert.equal(report.outcome, "invalid-input");
    assert.equal(report.error.code, "CONSUMER_INVALID");
    assert.match(report.error.message, /The base ref cannot start with a dash/u);
  });
});

test("rejects an explicit base that is ambiguous across ref namespaces", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    git(consumerRoot, "branch", "collision");
    git(consumerRoot, "tag", "collision");

    const { result, report } = runChanged(consumerRoot, "--base", "collision");
    assert.equal(result.status, 2);
    assert.equal(report.error.code, "CONSUMER_INVALID");
    assert.match(report.error.message, /explicit base ref.*is ambiguous/u);
    assert.match(report.error.message, /refs\/heads\/collision/u);
    assert.match(report.error.message, /refs\/tags\/collision/u);
  });
});

test("rejects revision expressions disguised as exact or shorthand refs", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    await writeFile(join(consumerRoot, "src", "index.ts"), "export const fixture = false;\n");
    git(consumerRoot, "add", "--", "src/index.ts");
    git(consumerRoot, "commit", "--message", "test: ref expression target");

    for (const base of ["refs/heads/main~1", "main~1"]) {
      const { result, report } = runChanged(consumerRoot, "--base", base);
      assert.equal(result.status, 2);
      assert.equal(report.error.code, "CONSUMER_INVALID");
      assert.match(report.error.message, /not an exact Git ref name/u);
    }
  });
});

test("rejects non-UTF8 Git paths instead of decoding replacement characters", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const gitPath = spawnSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).stdout.trim();
    const fakeBin = join(consumerRoot, ".fake-bin");
    await mkdir(fakeBin);
    const fakeGit = join(fakeBin, "git");
    await writeFile(
      fakeGit,
      `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
if (process.argv.includes("ls-files")) {
  process.stdout.write(Buffer.from([0xff, 0x2e, 0x74, 0x73, 0x00]));
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(gitPath)}, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
      "utf8",
    );
    await chmod(fakeGit, 0o755);
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "agent-workflow",
        "changed",
        "--base",
        "HEAD",
        "--consumer",
        consumerRoot,
        "--format",
        "json",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      },
    );
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, "");
    assert.equal(report.error.code, "CONSUMER_INVALID");
    assert.match(report.error.message, /not valid UTF-8/u);
  });
});

test("rejects Git path evidence without a terminating NUL", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    const gitPath = spawnSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).stdout.trim();
    const fakeBin = join(consumerRoot, ".fake-bin");
    await mkdir(fakeBin);
    const fakeGit = join(fakeBin, "git");
    await writeFile(
      fakeGit,
      `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
if (process.argv.includes("ls-files")) {
  process.stdout.write("src/malformed.ts");
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(gitPath)}, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
      "utf8",
    );
    await chmod(fakeGit, 0o755);
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "agent-workflow",
        "changed",
        "--base",
        "HEAD",
        "--consumer",
        consumerRoot,
        "--format",
        "json",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      },
    );
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 2);
    assert.equal(report.error.code, "CONSUMER_INVALID");
    assert.match(report.error.message, /malformed NUL-delimited/u);
  });
});

test("rejects ambiguous repository path characters instead of rewriting them", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    await writeFile(
      join(consumerRoot, "src", "back\\slash.ts"),
      "export const ambiguous = true;\n",
      "utf8",
    );
    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, "");
    assert.equal(report.outcome, "invalid-input");
    assert.equal(report.error.code, "CONSUMER_INVALID");
    assert.match(report.error.message, /Git reported an unsafe repository path/u);
  });
});

test("rejects changed symbolic links before invoking consumer scripts", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withAgentWorkflowFixture(async (consumerRoot) => {
    initializeRepository(consumerRoot);
    await symlink("index.ts", join(consumerRoot, "src", "linked.ts"));
    const { result, report } = runChanged(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, "");
    assert.equal(report.outcome, "invalid-input");
    assert.equal(report.error.code, "CONSUMER_INVALID");
    assert.match(report.error.message, /Changed path is not a regular file/u);
  });
});
