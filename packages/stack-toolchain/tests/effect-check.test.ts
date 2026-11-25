import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { ProcessRuntimeError, type ProcessRunResult, type Request } from "node-or-bun";
import { effectDiagnosticsContractVersion, checkEffectProjects } from "../dist/effect.js";
import { runEffectCli } from "../dist/features/toolchain-execution/adapters/effect-cli.js";
import {
  checkEffectProjectsWith,
  type EffectCheckDependencies,
} from "../dist/features/toolchain-execution/adapters/effect-check.js";
import {
  EffectCheckFailure,
  type EffectCheckInput,
} from "../dist/features/toolchain-execution/application/effect-policy.js";

const result = (change: Partial<ProcessRunResult> = {}): ProcessRunResult => ({
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  facts: {
    initiatingCause: "exit",
    completionRequestedBeforeExitObservation: false,
    observedExit: { exitCode: 0, signal: null },
    lateFailureCodes: [],
    outputBounded: true,
    incompleteCustody: false,
  },
  ...change,
});
const diagnostic = "main.ts(1,1): error TS377136: forbidden unstable export\n";

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "stack-effect-check-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cwd = await fs.realpath(directory);
  const source = path.join(cwd, "main.ts");
  const imported = path.join(cwd, "imported.ts");
  await fs.writeFile(source, 'export * from "./imported.js";');
  await fs.writeFile(imported, "export const answer = 42;");
  const config = {
    compilerOptions: {
      strict: true,
      noEmit: true,
      plugins: [
        {
          name: "@effect/language-service",
          diagnostics: true,
          diagnosticSeverity: { unstableApiUsage: "error", apiStabilityLeak: "error" },
          allowedUnstableApis: [],
          ignoreEffectErrorsInTscExitCode: false,
          ignoreEffectWarningsInTscExitCode: false,
          includeSuggestionsInTsc: false,
        },
      ],
    },
    files: ["./main.ts"],
  };
  for (const file of ["one.json", "two.json"]) {
    await fs.writeFile(path.join(cwd, file), JSON.stringify(config));
  }
  const calls: Request[] = [];
  let clock = 0;
  let admitted = 0;
  const controller = new AbortController();
  const input: EffectCheckInput = {
    cwd,
    projects: ["one.json", "two.json"],
    signal: controller.signal,
    budgetMs: 1000,
  };
  const answer = (request: Request): ProcessRunResult => {
    if (request.args.includes("--version")) {
      return result({ stdout: "Version 7.0.2+effect-tsgo.0.73.4\n" });
    }
    if (request.args.includes("--showConfig")) {
      return result({ stdout: JSON.stringify(config) });
    }
    if (request.args.includes("--listFilesOnly")) {
      return result({ stdout: source + "\n" + imported + "\n" });
    }
    return result();
  };
  const ports: EffectCheckDependencies = {
    platform: "linux",
    arch: "x64",
    now: () => clock,
    admit: async () => {
      admitted++;
      return {
        executable: path.join(cwd, "never-executed"),
        installation: path.join(cwd, "node_modules"),
        libraries: new Set(),
        reportedVersion: "Version 7.0.2+effect-tsgo.0.73.4",
        versions: {
          package: "@effect/tsgo-linux-x64",
          version: "0.73.4",
          typescript: "7.0.2",
          binarySha256: "admission-is-tested-separately",
          libraryCount: 108,
        },
      };
    },
    execute: async (request) => {
      calls.push(request);
      return answer(request);
    },
  };
  return {
    input,
    ports,
    calls,
    answer,
    controller,
    source,
    imported,
    config,
    admitted: () => admitted,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("all selected projects complete after diagnostics, using the same mandatory native route", async (t) => {
  const f = await fixture(t);
  const ports: EffectCheckDependencies = {
    ...f.ports,
    execute: async (request) => {
      f.calls.push(request);
      if (
        !request.args.some((flag) =>
          ["--version", "--showConfig", "--listFilesOnly"].includes(flag),
        ) &&
        request.args.at(-1) === path.join(f.input.cwd, "one.json")
      ) {
        return result({ exitCode: 1, stdout: diagnostic });
      }
      return f.answer(request);
    },
  };
  const report = await checkEffectProjectsWith(f.input, ports);
  assert.equal(report.exitCode, 1);
  assert.equal(report.details.outcome, "diagnostics");
  assert.deepEqual(
    report.details.projects.map((project) => project.status),
    ["diagnostics", "passed"],
  );
  assert.deepEqual(report.details.projects[0]?.diagnosticCodes, [377136]);
  assert.deepEqual(report.details.projects[1]?.sourceFiles, ["imported.ts", "main.ts"]);
  assert.deepEqual(report.details.unattempted, []);
  assert.equal(f.calls.length, 7);
  assert.equal(new Set(f.calls.map((call) => call.command)).size, 1);
  for (const call of f.calls.filter((request) => request.args.includes("--noEmit"))) {
    assert.equal(call.args[call.args.indexOf("--tsBuildInfoFile") + 1], devNull);
    assert.equal(call.args[call.args.indexOf("--incremental") + 1], "true");
    assert.equal(call.strictUtf8, true);
    assert.equal(call.environment, undefined);
    assert(!call.args.includes("--build") && !call.args.includes("--watch"));
  }
});

test("valid source passes only after version, config, imported-source inventory and check", async (t) => {
  const f = await fixture(t);
  const report = await checkEffectProjectsWith(f.input, f.ports);
  assert.equal(report.status, "passed");
  assert.equal(report.exitCode, 0);
  assert.equal(report.schemaVersion, effectDiagnosticsContractVersion);
  assert.equal(report.details.projects.length, 2);
  assert.equal(report.versions?.libraryCount, 108);
  assert.deepEqual(
    f.calls.slice(0, 4).map((call) => call.args[0]),
    ["--version", "--showConfig", "--listFilesOnly", "--noEmit"],
  );
});

test("invalid input, cancellation and unsupported platforms cannot start tool admission", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await checkEffectProjectsWith({ ...f.input, projects: [] }, f.ports)).details.outcome,
    "invalid-input",
  );
  const unsupported = await checkEffectProjectsWith(f.input, { ...f.ports, platform: "darwin" });
  assert.equal(unsupported.details.outcome, "tool-unavailable");
  assert.equal(unsupported.details.reason, "EFFECT_UNSUPPORTED_PLATFORM");
  assert.equal(unsupported.exitCode, 2);
  assert.deepEqual(unsupported.details.unattempted, f.input.projects);
  f.controller.abort();
  const cancelled = await checkEffectProjectsWith(f.input, f.ports);
  assert.equal(cancelled.exitCode, 130);
  assert.equal(cancelled.details.outcome, "cancelled");
  assert.equal(f.admitted(), 0);
  assert.equal(f.calls.length, 0);
});

test("unavailable or incompatible tools never become ordinary fallback success", async (t) => {
  const f = await fixture(t);
  const missing = await checkEffectProjectsWith(f.input, {
    ...f.ports,
    admit: async () => {
      throw new EffectCheckFailure("tool-unavailable", "EFFECT_NATIVE_MISSING");
    },
  });
  assert.equal(missing.details.outcome, "tool-unavailable");
  assert.deepEqual(missing.details.projects, []);
  const wrong = await checkEffectProjectsWith(f.input, {
    ...f.ports,
    execute: async (request) => {
      f.calls.push(request);
      return result({ stdout: "Version unqualified\n" });
    },
  });
  assert.equal(wrong.details.outcome, "tool-incompatible");
  assert.equal(wrong.details.reason, "EFFECT_REPORTED_VERSION");
  assert.equal(f.calls.length, 1);
});

test("missing leaf policy and suppressed imported source fail before semantic checking", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.input.cwd, "one.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, files: ["main.ts"] }),
  );
  const missing = await checkEffectProjectsWith(f.input, f.ports);
  assert.equal(missing.details.outcome, "invalid-input");
  assert.equal(missing.details.reason, "EFFECT_POLICY_PLUGIN");
  assert.deepEqual(missing.details.unattempted, ["two.json"]);
  assert.equal(f.calls.length, 1);
  await fs.writeFile(path.join(f.input.cwd, "one.json"), JSON.stringify(f.config));
  await fs.writeFile(f.imported, "// @effect-diagnostics *:skip-file\nexport const answer = 1;");
  f.calls.length = 0;
  const suppressed = await checkEffectProjectsWith(f.input, f.ports);
  assert.equal(suppressed.details.reason, "EFFECT_SOURCE_DIRECTIVE");
  assert.equal(suppressed.exitCode, 2);
  assert.equal(f.calls.length, 3);
});

test("probe failures and crash output cannot be mistaken for policy findings", async (t) => {
  const f = await fixture(t);
  for (const failingFlag of ["--showConfig", "--listFilesOnly", "--noEmit"]) {
    const report = await checkEffectProjectsWith(f.input, {
      ...f.ports,
      execute: async (request) => {
        if (request.args[0] === failingFlag) {
          return result({ exitCode: 1, stdout: diagnostic + "  runtime.gopanic()\n" });
        }
        return f.answer(request);
      },
    });
    assert.equal(report.exitCode, 2);
    assert.notEqual(report.details.outcome, "diagnostics");
    assert.deepEqual(report.details.unattempted, ["two.json"]);
    assert.equal(report.details.projects[0]?.status, "failed");
    assert.match(report.details.stdout ?? "", /runtime\.gopanic/u);
  }
});

test("bounded capture and complete process custody are mandatory even after known diagnostics", async (t) => {
  const f = await fixture(t);
  for (const facts of [
    { ...result().facts, outputBounded: false },
    { ...result().facts, incompleteCustody: true },
    { ...result().facts, lateFailureCodes: ["cleanup"] as const },
  ]) {
    const report = await checkEffectProjectsWith(f.input, {
      ...f.ports,
      execute: async (request) =>
        request.args[0] === "--noEmit"
          ? result({ exitCode: 1, stdout: diagnostic, facts })
          : f.answer(request),
    });
    assert.equal(report.details.outcome, "execution-failed");
    assert.equal(report.exitCode, 2);
    assert.deepEqual(report.details.projects[0]?.diagnosticCodes, []);
    assert.equal(report.details.stdout, diagnostic);
  }
});

test("process failures retain their bounded evidence and never trigger another engine", async (t) => {
  const f = await fixture(t);
  for (const code of [
    "timeout",
    "cancelled",
    "cleanup",
    "output-limit",
    "invalid-output",
    "stream",
    "launch",
  ] as const) {
    const report = await checkEffectProjectsWith(f.input, {
      ...f.ports,
      execute: async (request) => {
        if (request.args[0] === "--noEmit") {
          throw new ProcessRuntimeError(code, "controlled failure", {
            output: { stdout: diagnostic, stderr: "" },
          });
        }
        return f.answer(request);
      },
    });
    assert.equal(report.details.outcome, "execution-failed");
    assert.equal(report.details.reason, `EFFECT_PROCESS_${code.toUpperCase()}`);
    assert.equal(report.details.stdout, diagnostic);
    assert.deepEqual(report.details.unattempted, ["two.json"]);
  }
});

test("one deadline includes all probes and caller cancellation stays distinct", async (t) => {
  const f = await fixture(t);
  const report = await checkEffectProjectsWith(
    { ...f.input, budgetMs: 100 },
    {
      ...f.ports,
      execute: async (request) => {
        f.calls.push(request);
        f.advance(60);
        return f.answer(request);
      },
    },
  );
  assert.equal(report.details.reason, "EFFECT_DEADLINE");
  assert.equal(report.details.outcome, "execution-failed");
  assert.deepEqual(
    f.calls.map((call) => call.timeoutMs),
    [100, 40],
  );
  const cancelled = await checkEffectProjectsWith(f.input, {
    ...f.ports,
    execute: async () => {
      f.controller.abort();
      throw new ProcessRuntimeError("cancelled", "caller stopped");
    },
  });
  assert.equal(cancelled.exitCode, 130);
  assert.equal(cancelled.details.reason, "EFFECT_CANCELLED");
});

test("source changes during a successful check cannot yield a successful report", async (t) => {
  const f = await fixture(t);
  const report = await checkEffectProjectsWith(f.input, {
    ...f.ports,
    execute: async (request) => {
      if (request.args[0] === "--noEmit") {
        await fs.writeFile(f.imported, "export const changed = true;");
      }
      return f.answer(request);
    },
  });
  assert.equal(report.exitCode, 2);
  assert.equal(report.details.reason, "EFFECT_INPUT_CHANGED");
  assert.deepEqual(report.details.unattempted, ["two.json"]);
});

test("public API rejects invalid input and CLI dispatch exposes the same versioned JSON envelope", async () => {
  const report = await checkEffectProjects({
    cwd: process.cwd(),
    projects: [],
    signal: new AbortController().signal,
  });
  assert.equal(report.details.outcome, "invalid-input");
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const run = (args: readonly string[]) =>
    spawnSync(process.execPath, [cli, "effect:check", ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });
  const output = run(["--json"]);
  assert.equal(output.error, undefined);
  assert.equal(output.status, 2);
  assert.equal(output.stderr, "");
  const json = JSON.parse(output.stdout) as {
    schemaVersion: number;
    command: string;
    details: { outcome: string };
  };
  assert.equal(json.schemaVersion, effectDiagnosticsContractVersion);
  assert.equal(json.command, "effect:check");
  assert.equal(json.details.outcome, "invalid-input");
  const plain = run([]);
  assert.equal(plain.status, 2);
  assert.match(plain.stdout, /^effect:check: failed/u);
  await assert.rejects(
    runEffectCli(["--watch"], new AbortController().signal),
    /EFFECT_UNKNOWN_ARGUMENT/u,
  );
  await assert.rejects(
    runEffectCli(["--json", "--json"], new AbortController().signal),
    /EFFECT_UNKNOWN_ARGUMENT/u,
  );
  await assert.rejects(
    runEffectCli(["--project"], new AbortController().signal),
    /EFFECT_UNKNOWN_ARGUMENT/u,
  );
  await assert.rejects(
    runEffectCli(
      Array.from({ length: 130 }, () => "--json"),
      new AbortController().signal,
    ),
    /EFFECT_ARGUMENT_LIMIT/u,
  );
  const outside = run(["--json", "--project", "../outside.json"]);
  assert.equal(outside.status, 2);
  assert.match(outside.stdout, /EFFECT_PROJECT_PATH/u);
});
