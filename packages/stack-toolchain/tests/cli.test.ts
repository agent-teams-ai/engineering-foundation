import fs, {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installedDependency } from "./installed-dependency.ts";
import { runCommand as runLiteralCommand } from "../dist/index.js";
const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
function run(args: readonly string[]) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 10_000 });
}
void test("CLI rejects unknown command without launching tools", () => {
  const result = run(["unknown"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/u);
});
void test("CLI rejects unknown options without resolving native binaries", () => {
  const result = run(["typecheck", "--force-engine", "typescript"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /TOOLCHAIN_UNKNOWN_ARGUMENT/u);
});
void test("CLI rejects absent config argument", () => {
  const result = run(["typecheck", "--config"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /TOOLCHAIN_UNKNOWN_ARGUMENT/u);
});

void test("API rejects invalid budget before configuration or executable resolution", async () => {
  const { runCommand } = await import("../dist/features/toolchain-execution/adapters/commands.js");
  const result = await runCommand({
    command: "typecheck",
    cwd: "/nonexistent",
    signal: new AbortController().signal,
    budgetMs: 0,
  });
  assert.equal(result.exitCode, 2);
  assert.match(JSON.stringify(result.details), /TOOLCHAIN_INVALID_BUDGET/u);
});
void test("API honors already cancelled caller before reading configuration", async () => {
  const { runCommand } = await import("../dist/features/toolchain-execution/adapters/commands.js");
  const result = await runCommand({
    command: "typecheck",
    cwd: "/nonexistent",
    signal: AbortSignal.abort(),
  });
  assert.equal(result.exitCode, 130);
});
void test("API budget expiration is tooling failure rather than caller cancellation", async () => {
  const { runCommand } = await import("../dist/features/toolchain-execution/adapters/commands.js");
  const controller = new AbortController();
  const result = await runCommand({
    command: "typecheck",
    cwd: process.cwd(),
    signal: controller.signal,
    budgetMs: 1,
  });
  assert.equal(result.exitCode, 2);
  assert.equal(controller.signal.aborted, false);
});

void test("doctor rejects Bun as the mandatory CLI runtime", async () => {
  const { resolveExecutables } =
    await import("../src/features/toolchain-execution/adapters/executables.ts");
  const bun = resolveExecutables().bun;
  assert.notEqual(bun, null);
  const result = spawnSync(bun!.command, [entry, "doctor", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /TOOLCHAIN_UNSUPPORTED_NODE_RUNTIME/u);
});

for (const flag of ["--help", "-h"]) {
  void test(`CLI ${flag} succeeds without consumer configuration`, () => {
    const directory = mkdtempSync(join(tmpdir(), "stack-toolchain-help-"));
    try {
      const result = spawnSync(process.execPath, [entry, flag], {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /Usage: stack-toolchain/u);
      assert.equal(result.stderr, "");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

function lintFixture() {
  const directory = mkdtempSync(join(tmpdir(), "TEST-stack-lint-lanes-"));
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const tool = join(directory, "tool");
  const consumer = join(directory, "consumer");
  mkdirSync(join(tool, "node_modules"), { recursive: true });
  mkdirSync(join(consumer, "src"), { recursive: true });
  mkdirSync(join(consumer, "tests"));
  for (const name of ["dist", "presets", "toolchain-manifest.json"]) {
    cpSync(join(packageRoot, name), join(tool, name), { recursive: true });
  }
  const pins = JSON.parse(readFileSync(join(tool, "toolchain-manifest.json"), "utf8")) as Record<
    string,
    string
  >;
  writeFileSync(
    join(tool, "package.json"),
    JSON.stringify({
      name: "stack-toolchain",
      type: "module",
      dependencies: pins,
    }),
  );
  for (const name of ["node-or-bun", "typescript", "oxlint", "jsonc-parser"]) {
    symlinkSync(installedDependency(name), join(tool, "node_modules", name), "junction");
  }
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: "ES2024" },
      include: ["src", "tests"],
    }),
  );
  writeFileSync(join(consumer, "src/index.ts"), "Promise.resolve(1);\n");
  writeFileSync(join(consumer, "tests/outside.ts"), "Promise.resolve(1);\n");
  writeFileSync(join(consumer, "syntax.json"), JSON.stringify({ rules: { "use-isnan": "error" } }));
  writeFileSync(
    join(consumer, "typed.json"),
    JSON.stringify({ rules: { "typescript/no-floating-promises": "error" } }),
  );
  const config = {
    schemaVersion: 1,
    profile: "typescript-node",
    typecheck: { projects: ["tsconfig.json"] },
    lint: {
      config: "typed.json",
      paths: ["src"],
      syntax: { config: "syntax.json", paths: ["src", "tests"] },
    },
    format: { paths: ["src", "tests"] },
  };
  writeFileSync(join(consumer, "toolchain.config.json"), JSON.stringify(config));
  const invoke = () =>
    spawnSync(process.execPath, [join(tool, "dist/cli.js"), "lint", "--json"], {
      cwd: consumer,
      encoding: "utf8",
      timeout: 15_000,
    });
  const companion = () => {
    symlinkSync(
      installedDependency("oxlint-tsgolint"),
      join(tool, "node_modules/oxlint-tsgolint"),
      "junction",
    );
  };
  return { directory, consumer, config, invoke, companion };
}

interface LintReport {
  readonly exitCode: number;
  readonly details: {
    readonly lanes?: readonly {
      readonly name: string;
      readonly result: {
        readonly stdout?: string;
        readonly stderr?: string;
        readonly message?: string;
      };
    }[];
    readonly message?: string;
    readonly stdout?: string;
  };
}

void test("syntax failure short-circuits without resolving the absent typed companion", () => {
  const fixture = lintFixture();
  try {
    writeFileSync(
      join(fixture.consumer, "tests/outside.ts"),
      "if (NaN === 1) { throw new Error('bad'); }",
    );
    const result = fixture.invoke();
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout) as LintReport;
    assert.deepEqual(
      report.details.lanes?.map((lane) => lane.name),
      ["syntax"],
    );
    assert.match(JSON.stringify(report.details), /use-isnan/u);
    assert.doesNotMatch(JSON.stringify(report.details), /TSGOLINT/u);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

void test("syntax success retains its result when lazy typed companion resolution fails", () => {
  const fixture = lintFixture();
  try {
    const result = fixture.invoke();
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout) as LintReport;
    assert.deepEqual(
      report.details.lanes?.map((lane) => lane.name),
      ["syntax", "typed"],
    );
    assert.match(JSON.stringify(report.details.lanes[1]), /TOOLCHAIN_TSGOLINT_MISSING/u);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

void test("both lint configs are validated before either lane starts", () => {
  const fixture = lintFixture();
  try {
    writeFileSync(
      join(fixture.consumer, "tests/outside.ts"),
      "if (NaN === 1) { throw new Error('bad'); }",
    );
    writeFileSync(join(fixture.consumer, "typed.json"), '{"options":{"typeCheck":true}}');
    const result = fixture.invoke();
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout) as LintReport;
    assert.match(report.details.message ?? "", /TOOLCHAIN_LINT_SEMANTIC_CHECK_UNSUPPORTED/u);
    assert.equal(report.details.lanes, undefined);
    assert.doesNotMatch(JSON.stringify(report.details), /use-isnan/u);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

void test("real lint checks typed production while outside-scope TypeScript retains syntax only", () => {
  const fixture = lintFixture();
  try {
    fixture.companion();
    const failed = fixture.invoke();
    assert.equal(failed.status, 1, failed.stderr);
    const report = JSON.parse(failed.stdout) as LintReport;
    assert.deepEqual(
      report.details.lanes?.map((lane) => lane.name),
      ["syntax", "typed"],
    );
    const typed = JSON.stringify(report.details.lanes[1]);
    assert.match(typed, /no-floating-promises/u);
    assert.match(typed, /src[/\\]index\.ts/u);
    assert.doesNotMatch(typed, /outside\.ts/u);
    writeFileSync(join(fixture.consumer, "src/index.ts"), "void Promise.resolve(1);\n");
    const passed = fixture.invoke();
    assert.equal(passed.status, 0, passed.stderr);
    assert.deepEqual(
      (JSON.parse(passed.stdout) as LintReport).details.lanes?.map((lane) => lane.name),
      ["syntax", "typed"],
    );
    const { syntax: _syntax, ...flat } = fixture.config.lint;
    writeFileSync(
      join(fixture.consumer, "toolchain.config.json"),
      JSON.stringify({ ...fixture.config, lint: flat }),
    );
    const legacy = fixture.invoke();
    assert.equal(legacy.status, 0, legacy.stderr);
    const legacyReport = JSON.parse(legacy.stdout) as LintReport;
    assert.equal(legacyReport.details.lanes, undefined);
    assert.equal(typeof legacyReport.details.stdout, "string");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

void test("literal API rejects competing scope and commands before configuration", async () => {
  for (const command of ["doctor", "typecheck", "format:check"] as const) {
    const result = await runLiteralCommand({
      command,
      cwd: "/nonexistent",
      signal: new AbortController().signal,
      formatFiles: ["input.json"],
      ...(command === "format:check" ? { configPath: "never-read.json" } : {}),
    });
    assert.equal(result.exitCode, 2);
    assert.match(JSON.stringify(result.details), /TOOLCHAIN_FORMAT_MODE/u);
  }
});

void test(
  "literal refuses a POSIX FIFO before opening it",
  { skip: process.platform === "win32" },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "TEST-stack-literal-fifo-"));
    try {
      const consumer = join(directory, "consumer");
      const controls = join(directory, "controls");
      mkdirSync(consumer);
      mkdirSync(controls);
      const fifo = join(consumer, "input.json");
      const created = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 10_000 });
      assert.equal(created.status, 0, created.stderr);
      const before = lstatSync(fifo);
      const adapter = new URL(
        "../dist/features/toolchain-execution/adapters/format-files.js",
        import.meta.url,
      );
      const source = `
      import { checkFormatFiles } from ${JSON.stringify(adapter.href)};
      const result = await checkFormatFiles({
        cwd: process.cwd(), files: ["input.json"], fixedArgs: [],
        signal: new AbortController().signal, deadline: performance.now() + 1_000,
      }, async () => { throw new Error("must not invoke formatter"); });
      process.stdout.write(JSON.stringify(result));
    `;
      // A kernel-enforced child bound keeps the old blocking open from hanging this test.
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
        cwd: consumer,
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          TMPDIR: controls,
          TEMP: controls,
          TMP: controls,
          NODE_DISABLE_COMPILE_CACHE: "1",
        },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const report: unknown = JSON.parse(result.stdout);
      assert.partialDeepStrictEqual(report, {
        exitCode: 2,
        details: { failure: "TOOLCHAIN_FORMAT_FILE", attempted: [], completed: false },
      });
      const after = lstatSync(fifo);
      assert.ok(after.isFIFO());
      assert.equal(after.ino, before.ino);
      assert.equal(after.size, before.size);
      assert.deepEqual(fs.readdirSync(consumer), ["input.json"]);
      assert.deepEqual(fs.readdirSync(controls), []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

void test("literal native arguments preserve special names, override ambient ignores and preserve protected bytes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-stack-literal-names-"));
  const f = { consumer: join(directory, "consumer") };
  mkdirSync(f.consumer);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const names = ["[abc].json", "{a,b}.json", "space ü.json", "!leading.json", "-dash.json"];
  if (process.platform !== "win32") {
    names.push("*.json", "?.json");
  }
  fs.mkdirSync(join(f.consumer, "src"));
  fs.writeFileSync(join(f.consumer, ".gitignore"), "src/**\n");
  fs.writeFileSync(join(f.consumer, ".prettierignore"), "src/**\n");
  fs.writeFileSync(join(f.consumer, "src/.gitignore"), "*.json\n");
  const witness = '{"captured":[1,2]}';
  fs.writeFileSync(join(f.consumer, "protected.json"), witness);
  for (const name of names) {
    fs.writeFileSync(join(f.consumer, "src", name), "{}\n");
  }
  for (const name of names) {
    const file = `src/${name}`;
    for (const [source, expected] of [
      ['{"value":1}', 1],
      ["{}\n", 0],
    ] as const) {
      fs.writeFileSync(join(f.consumer, file), source);
      const result = await runLiteralCommand({
        command: "format:check",
        cwd: f.consumer,
        signal: new AbortController().signal,
        formatFiles: [file],
      });
      assert.equal(result.exitCode, expected, `${file}: ${JSON.stringify(result.details)}`);
      assert.partialDeepStrictEqual(result.details, {
        attempted: [file],
        completed: true,
        sourceBytesUnchanged: true,
      });
      assert.equal(fs.readFileSync(join(f.consumer, file), "utf8"), source);
    }
  }
  assert.equal(fs.readFileSync(join(f.consumer, "protected.json"), "utf8"), witness);
});
