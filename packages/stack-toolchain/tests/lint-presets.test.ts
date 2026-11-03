import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { fixFiles, runCommand } from "../dist/index.js";
import { parseCleanupArguments } from "../dist/features/toolchain-execution/adapters/cleanup-cli.js";
import { resolveCompilerExecutable } from "../dist/features/toolchain-execution/adapters/executables.js";

interface RuleMetadata {
  readonly scope: string;
  readonly value: string;
  readonly type_aware: boolean;
}
interface Preset {
  readonly extends: readonly string[];
  readonly options: Readonly<Record<string, boolean>>;
  readonly rules: Readonly<Record<string, string>>;
  readonly overrides: readonly {
    readonly files: readonly string[];
    readonly rules: Readonly<Record<string, string>>;
  }[];
}
interface Diagnostic {
  readonly filename: string;
  readonly code: string;
}

const require = createRequire(import.meta.url);
const cli = join(require.resolve("oxlint/package.json"), "..", "bin", "oxlint");
const presetPath = fileURLToPath(new URL("../presets/oxlint/type-aware.json", import.meta.url));
const preset = JSON.parse(readFileSync(presetPath, "utf8")) as Preset;

function oxlint(args: readonly string[]): ReturnType<typeof spawnSync> {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

void test("JS exception covers exactly the pinned typed rule universe", () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-toolchain-rule-metadata-"));
  try {
    const probe = join(directory, "probe.ts");
    writeFileSync(probe, "export const probe = 1;\n");
    const result = oxlint(["--rules", "--format=json", probe]);
    assert.equal(result.status, 0);
    const rules = JSON.parse(String(result.stdout)) as RuleMetadata[];
    const typed = rules
      .filter((rule) => rule.type_aware)
      .map((rule) => `${rule.scope}/${rule.value}`)
      .toSorted();
    assert.equal(typed.length, 59, "Review the exception when upgrading Oxlint");
    assert.equal(preset.overrides.length, 1);
    const exception = preset.overrides[0];
    assert.ok(exception);
    assert.deepEqual(exception.files, ["**/*.{js,jsx,mjs,cjs}"]);
    assert.deepEqual(Object.keys(exception.rules).toSorted(), typed);
    assert.ok(Object.values(exception.rules).every((level) => level === "off"));
    assert.deepEqual(preset.extends, ["./node.json"]);
    assert.deepEqual(preset.options, { typeAware: true, typeCheck: false });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("typed preset retains its existing global rule levels", () => {
  const errors = [
    "await-thenable",
    "no-array-delete",
    "no-base-to-string",
    "no-confusing-void-expression",
    "no-deprecated",
    "no-floating-promises",
    "no-for-in-array",
    "no-misused-promises",
    "no-misused-spread",
    "no-unnecessary-condition",
    "no-unnecessary-type-assertion",
    "no-unsafe-argument",
    "no-unsafe-assignment",
    "no-unsafe-call",
    "no-unsafe-declaration-merging",
    "no-unsafe-enum-comparison",
    "no-unsafe-function-type",
    "no-unsafe-member-access",
    "no-unsafe-return",
    "no-unsafe-unary-minus",
    "only-throw-error",
    "prefer-readonly",
    "require-array-sort-compare",
    "restrict-template-expressions",
    "strict-boolean-expressions",
    "switch-exhaustiveness-check",
    "unbound-method",
    "use-unknown-in-catch-callback-variable",
  ];
  const expected = Object.fromEntries(errors.map((rule) => [`typescript/${rule}`, "error"]));
  assert.deepEqual(preset.rules, {
    ...expected,
    "typescript/consistent-return": "off",
    "typescript/no-unsafe-type-assertion": "off",
  });
});

void test("all eight extensions retain syntax checks and only TS enables typed checks", () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-toolchain-lint-presets-"));
  try {
    const config = join(directory, "lint.json");
    writeFileSync(config, JSON.stringify({ extends: [presetPath] }));
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          allowJs: true,
          checkJs: true,
          noEmit: true,
          target: "ES2024",
        },
        include: ["*"],
      }),
    );
    const extensions = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"];
    for (const extension of extensions) {
      writeFileSync(
        join(directory, `probe-${extension}.${extension}`),
        'Promise.resolve(1);\nif (Number.NaN === 1) { throw new Error("bad"); }\n',
      );
    }
    const result = oxlint(["-c", config, "--type-aware", "--format=json", directory]);
    assert.equal(result.status, 1, String(result.stderr));
    const { diagnostics } = JSON.parse(String(result.stdout)) as { diagnostics: Diagnostic[] };
    assert.ok(diagnostics.every((diagnostic) => typeof diagnostic.code === "string"));
    for (const extension of extensions) {
      const messages = diagnostics.filter((diagnostic) =>
        diagnostic.filename.endsWith(`probe-${extension}.${extension}`),
      );
      assert.ok(
        messages.some((diagnostic) => diagnostic.code.includes("use-isnan")),
        extension,
      );
      assert.equal(
        messages.some((diagnostic) => diagnostic.code.includes("no-floating-promises")),
        ["ts", "tsx", "mts", "cts"].includes(extension),
        extension,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function cleanupFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "TEST-stack-cleanup-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    join(root, "input.ts"),
    'let value={ ["answer"]:42 };\nconsole.log(value.answer);\n',
  );
  writeFileSync(join(root, "other.ts"), 'let untouched={ ["answer"]:42 };\n');
  return root;
}
const cleanupPresetPath = fileURLToPath(new URL("../presets/oxlint/cleanup.json", import.meta.url));
const cleanupFixPath = fileURLToPath(
  new URL("../presets/oxlint/cleanup-fix.json", import.meta.url),
);
const cleanupCli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

void test("cleanup overlay cannot disable baseline categories or change other plugins", () => {
  const overlay: unknown = JSON.parse(readFileSync(cleanupPresetPath, "utf8"));
  assert.deepEqual(overlay, {
    rules: {
      "prefer-const": ["warn", { destructuring: "all", ignoreReadBeforeAssign: true }],
      "no-useless-rename": "warn",
      "no-useless-computed-key": ["warn", { enforceForClassMembers: false }],
    },
  });
  const writer: unknown = JSON.parse(readFileSync(cleanupFixPath, "utf8"));
  assert.deepEqual(writer, {
    extends: ["./cleanup.json"],
    categories: { correctness: "off" },
    plugins: ["eslint"],
    options: { typeAware: false, typeCheck: false },
  });
});

void test("cleanup option parsing requires a literal census and rejects extra fix modes", () => {
  assert.deepEqual(
    parseCleanupArguments(["--json", "--lint-config", "cleanup.json", "--", "input.ts"]),
    { json: true, lintConfigPath: "cleanup.json", files: ["input.ts"] },
  );
  for (const args of [
    [],
    ["--"],
    ["input.ts"],
    ["--fix-dangerously", "--", "input.ts"],
    ["--fix-suggestions", "--", "input.ts"],
    ["--lint-config"],
    ["--json", "--json", "--", "input.ts"],
  ]) {
    assert.throws(() => parseCleanupArguments(args));
  }
});

void test("cleanup native CLI preserves behavior, types, other files and second-run bytes", async (t) => {
  const root = cleanupFixture(t);
  const source = [
    'let value={ ["answer"]:42 };',
    "const { answer: answer } = value;",
    "const source = [0, 1, 2];",
    "const copy = source.map(x => x); copy.push(3);",
    "const filtered = source.filter(x => x);",
    "const flat = [[1], [2]].flatMap(x => x);",
    "const transformed = source.flatMap(x => x > 0 ? [x * 2] : []);",
    'const proto = { ["__proto__"]: 7 };',
    "let [stable, moving] = [1, 2]; moving += 1;",
    "const guard = (text: string | undefined): boolean => !!text;",
    'console.log(JSON.stringify({ answer, source, copy, filtered, flat, transformed, proto, stable, moving, guard: guard("x") }));',
    "export { answer as answer };",
  ].join("\n");
  writeFileSync(join(root, "input.ts"), source);
  writeFileSync(
    join(root, "toolchain.config.json"),
    "intentionally invalid: cleanup must not load this",
  );
  writeFileSync(
    join(root, "verify.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: "ES2023" },
      files: ["input.ts"],
    }),
  );
  const compilerPackage = require.resolve("typescript/package.json");
  const compiler = JSON.parse(readFileSync(compilerPackage, "utf8")) as { version: string };
  assert.equal(compiler.version, "7.0.2", "Never execute an older compiler for qualification");
  const executable = resolveCompilerExecutable();
  const typecheck = () => {
    const checked = spawnSync(
      executable.command,
      [...executable.prefix, "--project", "verify.json"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.ifError(checked.error);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  };
  const execute = () => {
    const executed = spawnSync(process.execPath, [join(root, "input.ts")], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(executed.error);
    assert.equal(executed.status, 0, executed.stderr);
    return executed.stdout;
  };
  typecheck();
  const before = execute();
  const other = readFileSync(join(root, "other.ts"), "utf8");
  const result = spawnSync(process.execPath, [cleanupCli, "fix", "--json", "--", "input.ts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const after = readFileSync(join(root, "input.ts"), "utf8");
  assert.match(after, /const value =/u);
  assert.match(after, /const \{ answer \} = value/u);
  assert.match(after, /export \{ answer \}/u);
  assert.match(after, /\["__proto__"\]/u);
  assert.match(after, /!!text/u);
  assert.match(after, /let \[stable, moving\]/u);
  assert.equal(execute(), before);
  typecheck();
  assert.equal(readFileSync(join(root, "other.ts"), "utf8"), other);
  const second = await fixFiles({
    cwd: root,
    files: ["input.ts"],
    signal: new AbortController().signal,
  });
  assert.equal(second.exitCode, 0, JSON.stringify(second));
  assert.deepEqual(second.details.changed, []);
  assert.equal(readFileSync(join(root, "input.ts"), "utf8"), after);
  const checked = await runCommand({
    command: "format:check",
    cwd: root,
    formatFiles: ["input.ts"],
    signal: new AbortController().signal,
  });
  assert.equal(checked.exitCode, 0, JSON.stringify(checked));
  assert.equal(readFileSync(join(root, "input.ts"), "utf8"), after);
});

void test("cleanup rejects the entire invalid census before any source write", async (t) => {
  const root = cleanupFixture(t);
  const before = readFileSync(join(root, "input.ts"), "utf8");
  mkdirSync(join(root, "directory.ts"));
  writeFileSync(join(root, "unsupported.json"), "{}\n");
  for (const files of [
    [],
    ["input.ts", "unsupported.json"],
    ["input.ts", "missing.ts"],
    ["input.ts", "input.ts"],
    ["input.ts", "directory.ts"],
    ["../input.ts"],
    ["./input.ts"],
    ["*.ts"],
    ["input.ts", "INPUT.ts"],
  ]) {
    const result = await fixFiles({ cwd: root, files, signal: new AbortController().signal });
    assert.equal(result.exitCode, 2, JSON.stringify(result));
    assert.deepEqual(result.details.attempted, []);
    assert.deepEqual(result.details.steps, []);
    assert.equal(readFileSync(join(root, "input.ts"), "utf8"), before);
  }
});

void test("cleanup rejects symlinks and hardlinks to unselected files", async (t) => {
  const root = cleanupFixture(t);
  const before = readFileSync(join(root, "other.ts"), "utf8");
  symlinkSync(join(root, "other.ts"), join(root, "symlink.ts"), "file");
  linkSync(join(root, "other.ts"), join(root, "hardlink.ts"));
  for (const file of ["symlink.ts", "hardlink.ts"]) {
    const result = await fixFiles({
      cwd: root,
      files: [file],
      signal: new AbortController().signal,
    });
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.details.attempted, []);
    assert.equal(readFileSync(join(root, "other.ts"), "utf8"), before);
  }
});

void test("cleanup keeps policy optional and rejects inherited executable or typed config", async (t) => {
  const root = cleanupFixture(t);
  const before = readFileSync(join(root, "input.ts"), "utf8");
  writeFileSync(join(root, "cleanup.json"), '{"extends":["./parent.json"]}\n');
  for (const config of [
    { jsPlugins: ["./untrusted.js"] },
    { options: { typeAware: true } },
    { options: { typeCheck: true } },
  ]) {
    writeFileSync(join(root, "parent.json"), JSON.stringify(config));
    const result = await fixFiles({
      cwd: root,
      files: ["input.ts"],
      lintConfigPath: "cleanup.json",
      signal: new AbortController().signal,
    });
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.details.attempted, []);
    assert.equal(readFileSync(join(root, "input.ts"), "utf8"), before);
  }
  writeFileSync(
    join(root, "cleanup.json"),
    JSON.stringify({ categories: { correctness: "off" }, rules: { "prefer-const": "off" } }),
  );
  const result = await fixFiles({
    cwd: root,
    files: ["input.ts"],
    lintConfigPath: "cleanup.json",
    signal: new AbortController().signal,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(readFileSync(join(root, "input.ts"), "utf8"), /let value/u);
});

void test("cleanup cancellation and invalid budgets never claim completion", async (t) => {
  const root = cleanupFixture(t);
  const before = readFileSync(join(root, "input.ts"), "utf8");
  const cancelled = await fixFiles({ cwd: root, files: ["input.ts"], signal: AbortSignal.abort() });
  assert.equal(cancelled.exitCode, 130);
  assert.equal(cancelled.details.completed, false);
  assert.deepEqual(cancelled.details.attempted, []);
  for (const budgetMs of [0, -1, Number.NaN]) {
    const result = await fixFiles({
      cwd: root,
      files: ["input.ts"],
      budgetMs,
      signal: new AbortController().signal,
    });
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.details.attempted, []);
  }
  assert.equal(readFileSync(join(root, "input.ts"), "utf8"), before);
});

void test("cleanup in-flight cancellation leaves an inspectable, retryable scope", async (t) => {
  const root = cleanupFixture(t);
  const other = readFileSync(join(root, "other.ts"), "utf8");
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 1);
  try {
    const result = await fixFiles({ cwd: root, files: ["input.ts"], signal: controller.signal });
    assert.equal(controller.signal.aborted, true);
    assert.equal(result.exitCode, 130);
    assert.equal(result.details.completed, false);
    assert.equal(readFileSync(join(root, "other.ts"), "utf8"), other);
    assert.equal(result.details.retainedControlDirectory, undefined);
    const retried = await fixFiles({
      cwd: root,
      files: ["input.ts"],
      signal: new AbortController().signal,
    });
    assert.equal(retried.exitCode, 0, JSON.stringify(retried));
  } finally {
    clearTimeout(timer);
  }
});
