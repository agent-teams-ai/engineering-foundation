import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
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

void test("experimental Bun lint is explicit and rejects incompatible inherited configuration", async () => {
  const root = fixture();
  try {
    const file = path.join(root, "toolchain.config.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8")) as { lint: Record<string, unknown> };
    config.lint["backend"] = "bun";
    fs.writeFileSync(file, JSON.stringify(config));
    await assert.rejects(loadConfiguration({ cwd: root }), /TOOLCHAIN_LINT_BACKEND_UNSUPPORTED/u);
    config.lint["backend"] = "bun-experimental";
    fs.writeFileSync(file, JSON.stringify(config));
    fs.writeFileSync(path.join(root, ".oxlintrc.json"), '{"extends":["./parent.json"]}');
    for (const value of [
      { plugins: ["vue"] },
      { rules: { "jsdoc/require-param": "error" } },
      { overrides: [{ files: ["**/*.?([cm])ts"], rules: {} }] },
      { rules: { "no-restricted-syntax": ["error", { pattern: "(?i)x" }] } },
      { rules: { "id-match": ["error", "(?i)x"] } },
    ]) {
      fs.writeFileSync(path.join(root, "parent.json"), JSON.stringify(value));
      await assert.rejects(loadConfiguration({ cwd: root }), /TOOLCHAIN_BUN_LINT_.*UNSUPPORTED/u);
    }
    fs.writeFileSync(path.join(root, "parent.json"), '{"ignorePatterns":["generated/"]}');
    assert.equal((await loadConfiguration({ cwd: root })).lint.backend, "bun-experimental");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("lint inheritance validates each lexical file-symlink context", async () => {
  const root = fixture();
  try {
    const configFile = path.join(root, "toolchain.config.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as {
      lint: Record<string, unknown>;
    };
    config.lint["backend"] = "bun-experimental";
    fs.writeFileSync(configFile, JSON.stringify(config));
    const shared = path.join(root, "shared");
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, "main.json"), '{"extends":["./base.json"]}');
    fs.writeFileSync(path.join(shared, "base.json"), "{}");
    fs.writeFileSync(path.join(root, "base.json"), '{"jsPlugins":[]}');
    fs.rmSync(path.join(root, ".oxlintrc.json"));
    fs.symlinkSync(path.join(shared, "main.json"), path.join(root, ".oxlintrc.json"));
    await assert.rejects(loadConfiguration({ cwd: root }), /TOOLCHAIN_LINT_CONFIG_EXECUTABLE/u);
    fs.rmSync(path.join(root, ".oxlintrc.json"));
    for (const name of ["left", "right"]) {
      fs.mkdirSync(path.join(root, name));
      fs.symlinkSync(path.join(shared, "main.json"), path.join(root, name, "main.json"));
      fs.writeFileSync(
        path.join(root, name, "base.json"),
        name === "left" ? "{}" : '{"jsPlugins":[]}',
      );
    }
    fs.writeFileSync(
      path.join(root, ".oxlintrc.json"),
      '{"extends":["./left/main.json","./right/main.json"]}',
    );
    await assert.rejects(loadConfiguration({ cwd: root }), /TOOLCHAIN_LINT_CONFIG_EXECUTABLE/u);
    fs.symlinkSync(shared, path.join(root, "linked"), "junction");
    fs.writeFileSync(path.join(root, ".oxlintrc.json"), '{"extends":["./linked/main.json"]}');
    assert.equal((await loadConfiguration({ cwd: root })).lint.backend, "bun-experimental");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
