import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createCheckerRunner } from "../src/features/toolchain-execution/adapters/process.ts";
import { resolveExecutables } from "../src/features/toolchain-execution/adapters/executables.ts";
import { typecheck } from "../src/features/toolchain-execution/application/typecheck.ts";
import fs from "node:fs";
import type { TestContext } from "node:test";
import { ProcessRuntimeError, type ProcessRunResult } from "node-or-bun";
import { checkFormatFiles } from "../dist/features/toolchain-execution/adapters/format-files.js";
import { runCommand, formatFilesContractVersion } from "../dist/index.js";
import { createHash } from "node:crypto";

const child = fileURLToPath(new URL("./checker-child.ts", import.meta.url));
const now = () => performance.now();
const executable = (mode: string) => ({ command: process.execPath, prefix: [child, mode] });

for (const mode of ["pass", "diagnostics", "unknown", "diagnostics-timeout"]) {
  void test(`real child: ${mode}, with no unwanted fallback`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "TEST-stack-checker-"));
    try {
      const run = createCheckerRunner({
        cwd,
        now,
        executables: {
          tsrs: executable(mode),
          bun: executable("pass"),
          typescript: executable("pass"),
        },
      });
      const result = await typecheck(
        {
          projects: ["tsconfig.json"],
          signal: new AbortController().signal,
          attemptBudgetMs: 500,
          budgetMs: 3_000,
        },
        { now, run },
      );
      assert.equal(result.status, mode === "pass" ? "passed" : "failed");
      if (mode.startsWith("diagnostics")) {
        assert.equal(result.status === "failed" && result.code, "TOOLCHAIN_DIAGNOSTICS");
      }
      assert.equal(
        (await readFile(join(cwd, "invocations.txt"), "utf8")).trim().split("\n").length,
        1,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

void test("real fallback runs Bun only when primary binary is unavailable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "TEST-stack-fallback-"));
  try {
    const run = createCheckerRunner({
      cwd,
      now,
      executables: {
        tsrs: null,
        bun: executable("pass"),
        typescript: executable("unknown"),
      },
    });
    const result = await typecheck(
      { projects: ["one.json", "two.json"], signal: new AbortController().signal },
      { now, run },
    );
    assert.equal(result.status, "passed-with-fallback");
    assert.equal(result.engine, "bun");
    const trace = await readFile(join(cwd, "invocations.txt"), "utf8");
    assert.equal(trace.trim().split("\n").length, 2);
    assert.match(trace, /check --no-pretty .* -p one.json/u);
    assert.match(trace, /check --no-pretty .* -p two.json/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("Bun fallback never dispatches consumer scripts.check", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "TEST-stack-bun-script-"));
  try {
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ scripts: { check: "touch injected-marker" } }),
    );
    await writeFile(join(cwd, "index.ts"), "const value: string = 12;");
    await writeFile(join(cwd, "tsconfig.json"), JSON.stringify({ files: ["index.ts"] }));
    const engines = resolveExecutables();
    assert.notEqual(engines.bun, null);
    const run = createCheckerRunner({ cwd, now, executables: { ...engines, tsrs: null } });
    const result = await typecheck(
      { projects: [join(cwd, "tsconfig.json")], signal: new AbortController().signal },
      { now, run },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.code, "TOOLCHAIN_DIAGNOSTICS");
    await assert.rejects(readFile(join(cwd, "injected-marker")), /ENOENT/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("all installed checkers retain composite diagnostics without metadata writes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "TEST-stack-composite-"));
  try {
    await writeFile(join(cwd, "package.json"), "{}");
    await writeFile(join(cwd, "index.ts"), "export const value = 1;");
    await writeFile(
      join(cwd, "tsconfig.json"),
      JSON.stringify({
        files: ["index.ts"],
        compilerOptions: { composite: true, skipLibCheck: true },
      }),
    );
    const engines = resolveExecutables();
    for (const engine of ["tsrs", "bun", "typescript"] as const) {
      if (engine === "tsrs" && engines.tsrs === null) {
        continue;
      }
      assert.notEqual(engines[engine], null, `Native qualification requires ${engine}`);
      const run = createCheckerRunner({ cwd, now, executables: engines });
      const input = {
        engine,
        projects: [join(cwd, "tsconfig.json")],
        signal: new AbortController().signal,
        deadline: now() + 30_000,
      };
      assert.equal((await run(input)).outcome.kind, "passed");
      await assert.rejects(readFile(join(cwd, "tsconfig.tsbuildinfo")), /ENOENT/u);
      await writeFile(join(cwd, "extra.ts"), "export const other = 1;");
      await writeFile(
        join(cwd, "index.ts"),
        'import { other } from "./extra"; export const value = other;',
      );
      const result = await run({ ...input, deadline: now() + 30_000 });
      assert.equal(result.outcome.kind, "diagnostics");
      assert.match(result.diagnostics.join("\n"), /TS6307/u);
      await assert.rejects(readFile(join(cwd, "tsconfig.tsbuildinfo")), /ENOENT/u);
      await writeFile(join(cwd, "index.ts"), "export const value = 1;");
      await rm(join(cwd, "extra.ts"));
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function literalFixture(t: TestContext) {
  const directory = fs.mkdtempSync(join(tmpdir(), "TEST-stack-literal-"));
  const consumer = join(directory, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(join(consumer, "good.json"), "{}\n");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, consumer };
}
function literalInput(cwd: string, files: readonly string[] = ["good.json"]) {
  return {
    cwd,
    files,
    signal: new AbortController().signal,
    deadline: performance.now() + 30_000,
    fixedArgs: [
      process.execPath,
      "/pinned/formatter",
      "--check",
      "--config",
      "/preset.json",
      "--disable-nested-config",
    ],
  };
}
const settled: ProcessRunResult = {
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
};

void test("literal validates every input before effects, including mixed unsupported and aliases", async (t) => {
  const f = literalFixture(t);
  fs.mkdirSync(join(f.consumer, "directory.json"));
  fs.writeFileSync(join(f.consumer, "unsupported.rs"), "unowned input");
  fs.linkSync(join(f.consumer, "good.json"), join(f.consumer, "hardlink.json"));
  fs.writeFileSync(join(f.directory, "outside.json"), "{}\n");
  fs.symlinkSync(join(f.directory, "outside.json"), join(f.consumer, "escape.json"), "file");
  const cases: readonly [readonly string[], string][] = [
    [[], "FILES"],
    [["good.json", "unsupported.rs"], "UNSUPPORTED"],
    [["missing.json"], "FILE"],
    [["directory.json"], "FILE"],
    [["./good.json"], "PATH"],
    [["../outside.json"], "PATH"],
    [[join(f.consumer, "good.json")], "PATH"],
    [["good.json", "good.json"], "IDENTITY"],
    [["UPPER.json", "upper.json"], "IDENTITY"],
    [["é.json", "e\u0301.json"], "IDENTITY"],
    [["good.json", "hardlink.json"], "IDENTITY"],
    [["escape.json"], "SYMLINK"],
    [["good.json."], "PATH"],
    [["NUL.json"], "PATH"],
    [["bad\n.json"], "PATH"],
    [["\ud800.json"], "PATH"],
  ];
  let calls = 0;
  for (const [files, code] of cases) {
    const result = await checkFormatFiles(literalInput(f.consumer, files), async () => {
      calls++;
      return settled;
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.details.failure, `TOOLCHAIN_FORMAT_${code}`);
    assert.deepEqual(result.details.attempted, []);
    assert.equal(result.details.completed, false);
  }
  assert.equal(calls, 0);
});

void test("literal API bypasses configuration and checks its entire qualified extension contract", async (t) => {
  const f = literalFixture(t);
  fs.writeFileSync(join(f.consumer, "toolchain.config.json"), "not a configuration");
  assert.equal(formatFilesContractVersion, 1);
  const syntax = [
    ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map((extension) => [
      extension,
      "const value={answer:1};",
      "const value = { answer: 1 };\n",
    ]),
    ...["json", "jsonc"].map((extension) => [extension, '{"answer":[1,2]}', "{}\n"]),
    ...["yaml", "yml"].map((extension) => [extension, "answer: [1,2]", "answer: [1, 2]\n"]),
    ["md", "# Title\n\n-   item\n", "# Title\n\n- item\n"],
  ];
  for (const [extension, bad, good] of syntax) {
    const file = `input.${extension}`;
    for (const [source, expected] of [
      [bad!, 1],
      [good!, 0],
    ] as const) {
      fs.writeFileSync(join(f.consumer, file), source);
      const result = await runCommand({
        command: "format:check",
        cwd: f.consumer,
        signal: new AbortController().signal,
        formatFiles: [file],
      });
      assert.equal(result.exitCode, expected, JSON.stringify(result.details));
      const digest = createHash("sha256")
        .update(JSON.stringify([file]))
        .digest("hex");
      assert.partialDeepStrictEqual(result.details, {
        schemaVersion: formatFilesContractVersion,
        requested: [file],
        validated: [file],
        attempted: [file],
        digests: { requested: digest, validated: digest, attempted: digest },
        completed: true,
        sourceBytesUnchanged: true,
      });
      assert.equal(fs.readFileSync(join(f.consumer, file), "utf8"), source);
    }
  }
  const mixed = await runCommand({
    command: "format:check",
    cwd: f.consumer,
    signal: new AbortController().signal,
    formatFiles: ["good.json", "unknown.mmd"],
  });
  assert.match(JSON.stringify(mixed.details), /TOOLCHAIN_FORMAT_UNSUPPORTED/u);
  assert.equal(mixed.exitCode, 2);
  fs.mkdirSync(join(f.consumer, "legacy"));
  fs.writeFileSync(join(f.consumer, "tsconfig.json"), "{}");
  fs.writeFileSync(join(f.consumer, "lint.json"), "{}");
  fs.writeFileSync(
    join(f.consumer, "toolchain.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      profile: "typescript-node",
      typecheck: { projects: ["tsconfig.json"] },
      lint: { config: "lint.json", paths: ["legacy"] },
      format: { paths: ["legacy"] },
    }),
  );
  const protectedBytes = '{"protected":[1,2]}';
  fs.writeFileSync(join(f.consumer, "protected.json"), protectedBytes);
  fs.writeFileSync(join(f.consumer, "legacy/input.json"), '{"bad":1}');
  fs.writeFileSync(join(f.consumer, "legacy/control.json"), "{}\n");
  const configured = () =>
    runCommand({
      command: "format:check",
      cwd: f.consumer,
      signal: new AbortController().signal,
    });
  fs.writeFileSync(join(f.consumer, ".prettierignore"), "legacy/input.json\n");
  assert.equal((await configured()).exitCode, 0);
  fs.writeFileSync(join(f.consumer, ".prettierignore"), "");
  assert.equal((await configured()).exitCode, 1);
  assert.equal(fs.readFileSync(join(f.consumer, "legacy/input.json"), "utf8"), '{"bad":1}');
  fs.writeFileSync(join(f.consumer, "legacy/input.json"), "{}\n");
  assert.equal((await configured()).exitCode, 0);
  assert.equal(fs.readFileSync(join(f.consumer, "protected.json"), "utf8"), protectedBytes);
});

void test("literal batches account for fixed argv, stop on later failure and retain exact partial sets", async (t) => {
  const f = literalFixture(t);
  const files = Array.from(
    { length: 220 },
    (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(120)}.json`,
  );
  for (const file of files) {
    fs.writeFileSync(join(f.consumer, file), "{}\n");
  }
  const input = literalInput(f.consumer, files);
  let calls = 0;
  const result = await checkFormatFiles(input, async (args, _cwd, budget) => {
    calls++;
    assert.ok(budget > 0 && budget <= 30_000);
    const quoted = [...input.fixedArgs, ...args]
      .map((arg) => `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
      .join(" ");
    assert.ok(quoted.length < 32_767);
    return { ...settled, exitCode: calls === 2 ? 1 : 0 };
  });
  assert.equal(calls, 2);
  assert.equal(result.exitCode, 1);
  assert.equal(result.details.completed, false);
  assert.ok(result.details.attempted.length < files.length);
  assert.deepEqual(
    result.details.attempted,
    result.details.batches.flatMap((batch) => batch.files),
  );
  assert.deepEqual(result.details.requested, files);
  assert.deepEqual(result.details.validated, files);
  const oversized = await checkFormatFiles(
    { ...input, fixedArgs: ["x".repeat(24 * 1024)] },
    async () => {
      throw new Error("must not invoke");
    },
  );
  assert.equal(oversized.details.failure, "TOOLCHAIN_FORMAT_ARGUMENTS");
});

void test("literal cancellation and uncertain process custody cannot pass or delete in-use controls", async (t) => {
  const f = literalFixture(t);
  const controller = new AbortController();
  const cancelled = await checkFormatFiles(
    { ...literalInput(f.consumer), signal: controller.signal },
    async () => {
      controller.abort();
      return settled;
    },
  );
  assert.equal(cancelled.exitCode, 2);
  assert.equal(cancelled.details.failure, "TOOLCHAIN_CANCELLED");
  const api = await runCommand({
    command: "format:check",
    cwd: f.consumer,
    signal: controller.signal,
    formatFiles: ["good.json"],
  });
  assert.equal(api.exitCode, 130);
  assert.equal(api.status, "failed");
  for (const incomplete of [false, true]) {
    const result = await checkFormatFiles(literalInput(f.consumer), async () => {
      if (incomplete) {
        return { ...settled, facts: { ...settled.facts, incompleteCustody: true } };
      }
      throw new Error("TOOLCHAIN_INCOMPLETE_PROCESS_RESULT");
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.details.completed, false);
    assert.ok(result.details.retainedControlDirectory);
    assert.equal(
      fs.readFileSync(join(result.details.retainedControlDirectory, "empty.ignore"), "utf8"),
      "",
    );
    fs.rmSync(result.details.retainedControlDirectory, { recursive: true });
  }
  const bounded = await checkFormatFiles(literalInput(f.consumer), async () => ({
    ...settled,
    facts: { ...settled.facts, outputBounded: false },
  }));
  assert.equal(bounded.details.failure, "TOOLCHAIN_INCOMPLETE_PROCESS_RESULT");
  assert.equal(bounded.details.retainedControlDirectory, undefined);
  const timed = await checkFormatFiles(literalInput(f.consumer), async () => {
    throw new ProcessRuntimeError("timeout", "private message", {
      facts: { observedExit: { exitCode: null, signal: "SIGTERM" } },
    });
  });
  assert.equal(timed.details.failure, "TOOLCHAIN_PROCESS_TIMEOUT");
  assert.doesNotMatch(JSON.stringify(timed.details), /private message/u);
});

void test("literal post-observation and cleanup cannot extend the original deadline", async (t) => {
  const f = literalFixture(t);
  let clock = 100;
  t.mock.method(performance, "now", () => clock);
  const originalRead = fs.openSync;
  let reads = 0;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const value = originalRead(...args);
    if (String(args[0]).endsWith("good.json") && ++reads === 3) {
      clock = 151;
    }
    return value;
  });
  const result = await checkFormatFiles(
    { ...literalInput(f.consumer), deadline: 150 },
    async () => settled,
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.details.failure, "TOOLCHAIN_DEADLINE");
  t.mock.restoreAll();
  clock = 100;
  t.mock.method(performance, "now", () => clock);
  const originalRemove = fs.rmdirSync;
  t.mock.method(fs, "rmdirSync", (...args: Parameters<typeof fs.rmdirSync>) => {
    originalRemove(...args);
    clock = 151;
  });
  const afterCleanup = await checkFormatFiles(
    { ...literalInput(f.consumer), deadline: 150 },
    async () => settled,
  );
  assert.equal(afterCleanup.exitCode, 2);
  assert.equal(afterCleanup.details.failure, "TOOLCHAIN_DEADLINE");
});

void test("literal control creation, outside-source placement and cleanup failures are explicit", async (t) => {
  const f = literalFixture(t);
  const originalWrite = fs.writeFileSync;
  let control: string | undefined;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]).endsWith("empty.ignore")) {
      control = path.dirname(String(args[0]));
      throw new Error("write failed");
    }
    return originalWrite(...args);
  });
  const early = await checkFormatFiles(literalInput(f.consumer), async () => settled);
  assert.equal(early.exitCode, 2);
  assert.ok(control);
  assert.equal(fs.existsSync(control), false);
  t.mock.restoreAll();
  const variables = ["TMPDIR", "TEMP", "TMP"];
  const prior = variables.map((key) => process.env[key]);
  try {
    for (const key of variables) {
      process.env[key] = f.consumer;
    }
    const inside = await checkFormatFiles(literalInput(f.consumer), async () => {
      throw new Error("must not invoke");
    });
    assert.equal(inside.details.failure, "TOOLCHAIN_FORMAT_TEMP_ROOT");
    assert.deepEqual(fs.readdirSync(f.consumer), ["good.json"]);
  } finally {
    variables.forEach((key, index) => {
      const value = prior[index];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }
  t.mock.method(fs, "rmdirSync", () => {
    throw new Error("cleanup failed");
  });
  const failed = await checkFormatFiles(literalInput(f.consumer), async () => settled);
  assert.equal(failed.exitCode, 2);
  assert.equal(failed.details.failure, "TOOLCHAIN_FORMAT_CLEANUP");
  assert.ok(failed.details.retainedControlDirectory);
  t.mock.restoreAll();
  fs.rmdirSync(failed.details.retainedControlDirectory);
});

void test("literal source mutation and changed controls refuse before another batch", async (t) => {
  const f = literalFixture(t);
  const mutation = await checkFormatFiles(literalInput(f.consumer), async () => {
    fs.writeFileSync(join(f.consumer, "good.json"), '{"changed":true}');
    return settled;
  });
  assert.equal(mutation.details.failure, "TOOLCHAIN_FORMAT_SOURCE_CHANGED");
  assert.equal(mutation.details.sourceBytesUnchanged, false);
  const files = Array.from(
    { length: 120 },
    (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(120)}.json`,
  );
  for (const file of files) {
    fs.writeFileSync(join(f.consumer, file), "{}\n");
  }
  let calls = 0;
  const changed = await checkFormatFiles(literalInput(f.consumer, files), async (args) => {
    calls++;
    fs.writeFileSync(args[1]!, "changed");
    return settled;
  });
  assert.equal(calls, 1);
  assert.equal(changed.details.failure, "TOOLCHAIN_FORMAT_CLEANUP");
  assert.ok(changed.details.retainedControlDirectory);
  fs.rmSync(changed.details.retainedControlDirectory, { recursive: true });
});
