import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixFiles, type CleanupReport } from "../dist/index.js";
import { loadConfiguration } from "../dist/features/toolchain-execution/adapters/configuration.js";

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "TEST-toolchain-config-"));
  fs.writeFileSync(path.join(root, "index.ts"), "const value: string = 12;");
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ files: ["index.ts"] }));
  fs.writeFileSync(path.join(root, ".oxlintrc.json"), "{}");
  fs.writeFileSync(
    path.join(root, "toolchain.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      profile: "typescript-node",
      typecheck: { projects: ["tsconfig.json"] },
      lint: { config: ".oxlintrc.json", paths: ["."] },
      format: { paths: ["."] },
    }),
  );
  return root;
}
void test("official parser accepts config without semantic checking", async () => {
  const root = fixture();
  try {
    assert.deepEqual((await loadConfiguration({ cwd: root })).projects, [
      path.join(root, "tsconfig.json"),
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
void test("rejects unknown fields and ancestor discovery", async () => {
  const root = fixture();
  try {
    const file = path.join(root, "toolchain.config.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...value, fallbackOnDiagnostics: true }));
    await assert.rejects(loadConfiguration({ cwd: root }), /TOOLCHAIN_CONFIG_FIELDS/u);
    fs.mkdirSync(path.join(root, "child"));
    await assert.rejects(loadConfiguration({ cwd: path.join(root, "child") }), /ENOENT/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
void test("rejects references and empty source scope", async () => {
  const root = fixture();
  try {
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ files: [], references: [] }),
    );
    await assert.rejects(loadConfiguration({ cwd: root }));
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ include: ["absent/**/*.ts"] }),
    );
    await assert.rejects(loadConfiguration({ cwd: root }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("rejects direct and inherited noCheck before checker execution", async () => {
  const root = fixture();
  try {
    fs.writeFileSync(
      path.join(root, "base.json"),
      JSON.stringify({ compilerOptions: { noCheck: true } }),
    );
    for (const config of [
      { files: ["index.ts"], compilerOptions: { noCheck: true } },
      { extends: "./base.json", files: ["index.ts"] },
    ]) {
      fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify(config));
      await assert.rejects(loadConfiguration({ cwd: root }), /TOOLCHAIN_NOCHECK_UNSUPPORTED/u);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("accepts inherited composite without writing metadata during configuration", async () => {
  const root = fixture();
  try {
    fs.writeFileSync(
      path.join(root, "base.json"),
      JSON.stringify({ compilerOptions: { composite: true } }),
    );
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ extends: "./base.json", files: ["index.ts"] }),
    );
    await loadConfiguration({ cwd: root });
    assert.equal(fs.existsSync(path.join(root, "tsconfig.tsbuildinfo")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
void test("rejects option injection in lint and format paths", async () => {
  const root = fixture();
  try {
    const file = path.join(root, "toolchain.config.json");
    const source = fs.readFileSync(file, "utf8");
    for (const field of ["lint", "format"]) {
      const value = JSON.parse(source) as Record<string, { paths: string[] }>;
      value[field]!.paths = ["--version"];
      fs.writeFileSync(file, JSON.stringify(value));
      await assert.rejects(loadConfiguration({ cwd: root }), /TOOLCHAIN_CONFIG_PATH/u);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("rejects executable lint configs and inherited JavaScript plugins", async () => {
  const root = fixture();
  try {
    fs.writeFileSync(
      path.join(root, "parent.json"),
      JSON.stringify({ overrides: [{ jsPlugins: ["./plugin.js"] }] }),
    );
    fs.writeFileSync(
      path.join(root, ".oxlintrc.json"),
      JSON.stringify({ extends: ["./parent.json"] }),
    );
    await assert.rejects(loadConfiguration({ cwd: root }), /TOOLCHAIN_LINT_CONFIG_EXECUTABLE/u);
    const filename = path.join(root, "toolchain.config.json");
    const config = JSON.parse(fs.readFileSync(filename, "utf8")) as { lint: { config: string } };
    config.lint.config = "config.ts";
    fs.writeFileSync(filename, JSON.stringify(config));
    fs.writeFileSync(path.join(root, "config.ts"), 'throw new Error("must never execute")');
    await assert.rejects(
      loadConfiguration({ cwd: root }),
      /TOOLCHAIN_LINT_CONFIG_EXECUTABLE_OR_CYCLE/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("permits shared JSON preset diamonds while rejecting actual cycles", async () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "base.json"), "{}");
    fs.writeFileSync(path.join(root, "a.json"), '{"extends":["./base.json"]}');
    fs.writeFileSync(path.join(root, "b.json"), '{"extends":["./base.json"]}');
    fs.writeFileSync(path.join(root, ".oxlintrc.json"), '{"extends":["./a.json","./b.json"]}');
    await loadConfiguration({ cwd: root });
    fs.writeFileSync(path.join(root, "base.json"), '{"extends":["./a.json"]}');
    await assert.rejects(
      loadConfiguration({ cwd: root }),
      /TOOLCHAIN_LINT_CONFIG_EXECUTABLE_OR_CYCLE/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("rejects hidden semantic type checks in inherited lint overrides", async () => {
  const root = fixture();
  try {
    fs.writeFileSync(
      path.join(root, "parent.json"),
      JSON.stringify({ overrides: [{ options: { typeCheck: true } }] }),
    );
    fs.writeFileSync(path.join(root, ".oxlintrc.json"), '{"extends":["./parent.json"]}');
    await assert.rejects(
      loadConfiguration({ cwd: root }),
      /TOOLCHAIN_LINT_SEMANTIC_CHECK_UNSUPPORTED/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("optional syntax scope is explicit while flat lint configuration stays unchanged", async () => {
  const root = fixture();
  try {
    const file = path.join(root, "toolchain.config.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8")) as { lint: Record<string, unknown> };
    const flat = (await loadConfiguration({ cwd: root })).lint;
    assert.deepEqual(flat, { config: path.join(root, ".oxlintrc.json"), paths: ["."] });
    config.lint["syntax"] = { config: ".oxlintrc.json", paths: ["scripts", "tests"] };
    fs.writeFileSync(file, JSON.stringify(config));
    assert.deepEqual((await loadConfiguration({ cwd: root })).lint, {
      ...flat,
      syntax: { config: path.join(root, ".oxlintrc.json"), paths: ["scripts", "tests"] },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("syntax scope rejects unknown fields, empty paths, duplicates and option injection", async () => {
  const root = fixture();
  try {
    const file = path.join(root, "toolchain.config.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8")) as { lint: Record<string, unknown> };
    for (const syntax of [
      null,
      {},
      { config: ".oxlintrc.json", paths: [] },
      { config: ".oxlintrc.json", paths: ["src", "./src"] },
      { config: ".oxlintrc.json", paths: ["--fix"] },
      { config: "../outside.json", paths: ["src"] },
      { config: ".oxlintrc.json", paths: ["../outside"] },
      { config: ".oxlintrc.json", paths: ["src"], command: "shell" },
    ]) {
      config.lint["syntax"] = syntax;
      fs.writeFileSync(file, JSON.stringify(config));
      await assert.rejects(loadConfiguration({ cwd: root }), /TOOLCHAIN_CONFIG_/u);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("syntax preflight rejects inherited typed options, plugins and config cycles", async () => {
  const root = fixture();
  try {
    const file = path.join(root, "toolchain.config.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8")) as { lint: Record<string, unknown> };
    config.lint["syntax"] = { config: "syntax.json", paths: ["tests"] };
    fs.writeFileSync(file, JSON.stringify(config));
    fs.writeFileSync(path.join(root, "syntax.json"), '{"extends":["./parent.json"]}');
    for (const [value, expected] of [
      [{ options: { typeAware: true } }, /TOOLCHAIN_SYNTAX_LINT_TYPE_AWARE/u],
      [{ options: { typeCheck: true } }, /TOOLCHAIN_LINT_SEMANTIC_CHECK_UNSUPPORTED/u],
      [{ jsPlugins: [] }, /TOOLCHAIN_LINT_CONFIG_EXECUTABLE/u],
      [{ extends: ["./syntax.json"] }, /TOOLCHAIN_LINT_CONFIG_EXECUTABLE_OR_CYCLE/u],
    ] as const) {
      fs.writeFileSync(path.join(root, "parent.json"), JSON.stringify(value));
      await assert.rejects(loadConfiguration({ cwd: root }), expected);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("cleanup rejects oversized and non-file inherited configs before writes", async (t) => {
  const root = fixture();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const before = fs.readFileSync(path.join(root, "index.ts"), "utf8");
  fs.writeFileSync(path.join(root, "oversized.json"), "{}");
  fs.truncateSync(path.join(root, "oversized.json"), 4_000_001);
  fs.mkdirSync(path.join(root, "directory.json"));
  for (const parent of ["oversized.json", "directory.json"]) {
    fs.writeFileSync(
      path.join(root, ".oxlintrc.json"),
      JSON.stringify({ extends: [`./${parent}`] }),
    );
    const result = await fixFiles({
      cwd: root,
      files: ["index.ts"],
      lintConfigPath: ".oxlintrc.json",
      signal: new AbortController().signal,
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.details.completed, false);
    assert.deepEqual(result.details.attempted, []);
    assert.deepEqual(result.details.steps, []);
    assert.equal(fs.readFileSync(path.join(root, "index.ts"), "utf8"), before);
  }
});

void test(
  "cleanup CLI rejects inherited FIFOs without blocking or writing",
  { skip: process.platform === "win32" },
  (t) => {
    // POSIX FIFO syntax is the rejecting fixture; the actual CLI is the boundary.
    const root = fixture();
    t.after(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });
    const before = fs.readFileSync(path.join(root, "index.ts"), "utf8");
    fs.writeFileSync(path.join(root, ".oxlintrc.json"), '{"extends":["./pipe.json"]}\n');
    const fifo = spawnSync("mkfifo", [path.join(root, "pipe.json")], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(fifo.error);
    assert.equal(fifo.status, 0, fifo.stderr);
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [cli, "fix", "--json", "--lint-config", ".oxlintrc.json", "--", "index.ts"],
      { cwd: root, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout) as CleanupReport;
    assert.equal(report.details.failure, "TOOLCHAIN_LINT_CONFIG_FILE");
    assert.equal(report.details.completed, false);
    assert.deepEqual(report.details.attempted, []);
    assert.deepEqual(report.details.steps, []);
    assert.equal(fs.readFileSync(path.join(root, "index.ts"), "utf8"), before);
  },
);

void test("cleanup validates each inherited symlink alias in the native config directory", async (t) => {
  const root = fixture();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const before = fs.readFileSync(path.join(root, "index.ts"), "utf8");
  fs.mkdirSync(path.join(root, "actual"));
  fs.mkdirSync(path.join(root, "linked"));
  fs.writeFileSync(path.join(root, "actual", "bridge.json"), '{"extends":["./policy.json"]}');
  fs.writeFileSync(path.join(root, "actual", "policy.json"), "{}");
  fs.symlinkSync(
    path.join(root, "actual", "bridge.json"),
    path.join(root, "linked", "bridge.json"),
    "file",
  );
  for (const parents of [
    ["./linked/bridge.json"],
    ["./actual/bridge.json", "./linked/bridge.json"],
  ]) {
    fs.writeFileSync(path.join(root, ".oxlintrc.json"), JSON.stringify({ extends: parents }));
    for (const [policy, failure] of [
      [{ jsPlugins: [] }, "TOOLCHAIN_LINT_CONFIG_EXECUTABLE"],
      [{ options: { typeAware: true } }, "TOOLCHAIN_SYNTAX_LINT_TYPE_AWARE"],
      [{ options: { typeCheck: true } }, "TOOLCHAIN_LINT_SEMANTIC_CHECK_UNSUPPORTED"],
    ] as const) {
      fs.writeFileSync(path.join(root, "linked", "policy.json"), JSON.stringify(policy));
      const result = await fixFiles({
        cwd: root,
        files: ["index.ts"],
        lintConfigPath: ".oxlintrc.json",
        signal: new AbortController().signal,
      });
      assert.equal(result.details.failure, failure, JSON.stringify(result));
      assert.equal(result.exitCode, 2);
      assert.deepEqual(result.details.attempted, []);
      assert.deepEqual(result.details.steps, []);
      assert.equal(fs.readFileSync(path.join(root, "index.ts"), "utf8"), before);
    }
  }
});

void test("cleanup preserves data-only symlink presets and rejects executable path aliases", async (t) => {
  const root = fixture();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "actual"));
  fs.mkdirSync(path.join(root, "linked"));
  fs.writeFileSync(path.join(root, "actual", "bridge.json"), '{"extends":["./policy.json"]}');
  // The real target's sibling is not inherited by Oxlint through the alias.
  fs.writeFileSync(path.join(root, "actual", "policy.json"), '{"jsPlugins":[]}');
  fs.writeFileSync(
    path.join(root, "linked", "policy.json"),
    '{"categories":{"correctness":"off"},"rules":{"no-useless-computed-key":"warn"}}',
  );
  const filename = path.join(root, "index.ts");
  fs.writeFileSync(filename, 'console.log({["answer"]:42});\n');
  for (const alias of ["bridge.json", "bridge.ts"]) {
    fs.symlinkSync(
      path.join(root, "actual", "bridge.json"),
      path.join(root, "linked", alias),
      "file",
    );
    fs.writeFileSync(
      path.join(root, ".oxlintrc.json"),
      JSON.stringify({ extends: [`./linked/${alias}`] }),
    );
    const result = await fixFiles({
      cwd: root,
      files: ["index.ts"],
      lintConfigPath: ".oxlintrc.json",
      signal: new AbortController().signal,
    });
    if (alias.endsWith(".ts")) {
      assert.equal(result.details.failure, "TOOLCHAIN_LINT_CONFIG_EXECUTABLE_OR_CYCLE");
      assert.deepEqual(result.details.steps, []);
    } else {
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.match(fs.readFileSync(filename, "utf8"), /\{ answer: 42 \}/u);
    }
  }
});

void test("cleanup CLI follows native symlink parent traversal before admitting config", (t) => {
  const root = fixture();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "actual", "inner"), { recursive: true });
  fs.symlinkSync(
    path.join(root, "actual", "inner"),
    path.join(root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const source = path.join(root, "index.ts");
  const before = 'console.log({["answer"]:42});\n';
  fs.writeFileSync(source, before);
  fs.writeFileSync(path.join(root, ".oxlintrc.json"), '{"extends":["./linked/../policy.json"]}');
  const canary = path.join(root, "plugin-loaded");
  const directories = [root, path.join(root, "actual")];
  // Native JS plugin syntax is the rejecting fixture, never maintained application code.
  for (const directory of directories) {
    fs.writeFileSync(path.join(directory, "policy.json"), "{}");
    fs.writeFileSync(
      path.join(directory, "plugin.mjs"),
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(canary)}, "loaded"); export default { meta: { name: "canary" }, rules: {} };`,
    );
  }
  // Raw filesystem IO, not path.join/resolve, selects this platform's native parent.
  const inherited = `${path.join(root, "linked")}${path.sep}..${path.sep}policy.json`;
  fs.writeFileSync(inherited, '{"jsPlugins":["./plugin.mjs"]}');
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const invoke = () =>
    spawnSync(
      process.execPath,
      [cli, "fix", "--json", "--lint-config", ".oxlintrc.json", "--", "index.ts"],
      { cwd: root, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
    );
  const rejected = invoke();
  assert.ifError(rejected.error);
  assert.equal(rejected.status, 2, rejected.stdout + rejected.stderr);
  const report = JSON.parse(rejected.stdout) as CleanupReport;
  assert.equal(report.details.failure, "TOOLCHAIN_LINT_CONFIG_EXECUTABLE");
  assert.deepEqual(report.details.steps, []);
  assert.deepEqual(report.details.attempted, []);
  assert.equal(fs.existsSync(canary), false);
  assert.equal(fs.readFileSync(source, "utf8"), before);
  // An unselected sibling must not govern the inherited native configuration.
  for (const directory of directories) {
    fs.writeFileSync(path.join(directory, "policy.json"), '{"jsPlugins":["./plugin.mjs"]}');
  }
  fs.writeFileSync(
    inherited,
    '{"categories":{"correctness":"off"},"rules":{"no-useless-computed-key":"warn"}}',
  );
  const accepted = invoke();
  assert.ifError(accepted.error);
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.equal(fs.existsSync(canary), false);
  assert.match(fs.readFileSync(source, "utf8"), /\{ answer: 42 \}/u);
});

void test("cleanup API honors native cwd traversal and leaves sibling sources untouched", async (t) => {
  const root = fixture();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "actual", "inner"), { recursive: true });
  fs.symlinkSync(
    path.join(root, "actual", "inner"),
    path.join(root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const cwd = `${root}${path.sep}linked${path.sep}..`;
  const files = [path.join(root, "index.ts"), path.join(root, "actual", "index.ts")];
  const untouched = 'console.log({["unselected"]:99});\n';
  for (const file of files) {
    fs.writeFileSync(file, untouched);
  }
  // Raw IO establishes the caller-selected file independently of root normalization.
  const selected = `${cwd}${path.sep}index.ts`;
  fs.writeFileSync(selected, 'console.log({["selected"]:42});\n');
  const siblings = files.filter((file) => fs.readFileSync(file, "utf8") === untouched);
  assert.equal(siblings.length, 1);
  for (const pass of [0, 1]) {
    const report = await fixFiles({
      cwd,
      files: ["index.ts"],
      signal: new AbortController().signal,
    });
    assert.equal(report.exitCode, 0, JSON.stringify(report));
    assert.equal(report.details.completed, true);
    assert.equal(report.details.sourceObservationComplete, true);
    assert.deepEqual(report.details.changed, pass === 0 ? ["index.ts"] : []);
    assert.equal(fs.readFileSync(selected, "utf8"), "console.log({ selected: 42 });\n");
    assert.equal(fs.readFileSync(siblings[0]!, "utf8"), untouched);
  }
});
