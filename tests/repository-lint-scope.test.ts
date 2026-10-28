import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { qualitySourceTargets } from "../packages/engineering-foundation/dist/features/quality-coverage/application/source-coverage.js";
import { mapQualityTopology } from "../packages/engineering-foundation/dist/features/quality-coverage/adapters/profile-input.js";
import { repositorySourceRoot } from "./support/repository-source.ts";

interface Configuration {
  readonly extends: readonly string[];
  readonly ignorePatterns: readonly string[];
  readonly options?: Readonly<Record<string, unknown>>;
  readonly rules?: Readonly<Record<string, unknown>>;
  readonly overrides?: readonly unknown[];
}
interface LintScope {
  readonly config: string;
  readonly paths: readonly string[];
}
interface Diagnostic {
  readonly filename: string;
  readonly code: string;
}
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const cli = join(require.resolve("oxlint/package.json"), "..", "bin", "oxlint");
const typedRequire = createRequire(require.resolve("oxlint-tsgolint/package.json"));
const typedExecutable = join(
  dirname(
    typedRequire.resolve(`@oxlint-tsgolint/${process.platform}-${process.arch}/package.json`),
  ),
  process.platform === "win32" ? "tsgolint.exe" : "tsgolint",
);
const roots = ["packages", "scripts", "tools", "tests"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): readonly string[] {
  assert.ok(Array.isArray(value));
  return value.map((entry: unknown) => {
    assert.equal(typeof entry, "string");
    assert.ok(typeof entry === "string");
    return entry;
  });
}
function configuration(name: string): Configuration {
  return JSON.parse(readFileSync(join(root, name), "utf8")) as Configuration;
}
function scope(value: unknown): LintScope {
  assert.ok(record(value));
  assert.ok(typeof value.config === "string");
  return { config: value.config, paths: strings(value.paths) };
}
function lintScopes(): { typed: LintScope; syntax: LintScope } {
  const toolchain: unknown = JSON.parse(readFileSync(join(root, "toolchain.config.json"), "utf8"));
  assert.ok(record(toolchain) && record(toolchain.lint));
  return { typed: scope(toolchain.lint), syntax: scope(toolchain.lint.syntax) };
}
function lint(args: readonly string[], cwd = root): string {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, OXLINT_TSGOLINT_PATH: typedExecutable },
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  assert.doesNotMatch(result.stdout, /^Failed to /u);
  return result.stdout;
}
function census(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["dist", "node_modules", ".git"].includes(entry.name)) {
      return [];
    }
    const path = join(directory, entry.name);
    return entry.isDirectory() ? census(path) : [relative(root, path).replaceAll("\\", "/")];
  });
}
function sourceAuthority(): Parameters<typeof qualitySourceTargets>[2] {
  const value: unknown = parse(
    readFileSync(join(root, "architecture/foundation/source-dependencies.yaml"), "utf8"),
  );
  assert.ok(record(value) && record(value.workspace) && Array.isArray(value.boundaries));
  assert.ok(typeof value.workspace.manifest === "string");
  return {
    workspaceManifestPath: value.workspace.manifest,
    boundaries: value.boundaries.map((entry: unknown) => {
      assert.ok(record(entry) && typeof entry.id === "string");
      const mode = entry.dependencyMode;
      assert.ok(mode === undefined || mode === "runtime" || mode === "development");
      return {
        id: entry.id,
        roots: strings(entry.roots),
        ...(mode === undefined ? {} : { dependencyMode: mode }),
      };
    }),
  };
}

void test("split lint preserves the original syntax scope and production typed policy", () => {
  const typed = configuration(".oxlintrc.type-aware.json");
  assert.deepEqual(typed.extends, [
    "./node_modules/stack-toolchain/presets/oxlint/type-aware.json",
    "./node_modules/stack-toolchain/presets/oxlint/maintainability.json",
    "./.oxlintrc.repository-mutation-budgets.json",
  ]);
  assert.deepEqual(typed.ignorePatterns, ["packages/*/dist/**", "packages/*/node_modules/**"]);
  assert.deepEqual(typed.options, {
    respectEslintDisableDirectives: false,
    reportUnusedDisableDirectives: "error",
  });
  assert.equal(typed.rules, undefined);
  assert.equal(typed.overrides, undefined);
  const selected = lintScopes();
  assert.equal(selected.typed.config, ".oxlintrc.type-aware.json");
  assert.deepEqual(selected.syntax, { config: ".oxlintrc.json", paths: roots });
});

void test("actual typed selection equals authoritative quality production targets", async () => {
  const topology: unknown = JSON.parse(
    readFileSync(join(root, "architecture/foundation/feature-modules.json"), "utf8"),
  );
  const expected = qualitySourceTargets(
    roots.flatMap((directory) => census(join(root, directory))),
    mapQualityTopology(topology, "architecture/foundation/source-dependencies.yaml"),
    sourceAuthority(),
  );
  assert.ok(expected.length > 0);
  const selected = lintScopes();
  const args = [
    "--config",
    selected.typed.config,
    "--disable-nested-config",
    "--debug",
    "files",
    "--",
  ];
  // Directory discovery uses the source; explicit names retain the same scope
  // inside a profile below an ancestor's ignored .worker-tmp directory.
  const actual = lint([...args, ...selected.typed.paths], await repositorySourceRoot())
    .trim()
    .split(/\r?\n/u)
    .toSorted();
  assert.deepEqual(actual, expected);
  const projected: string[] = [];
  let batch: string[] = [];
  let bytes = 0;
  const verifyBatch = (): void => {
    if (batch.length > 0) {
      projected.push(
        ...lint([...args, ...batch])
          .trim()
          .split(/\r?\n/u),
      );
    }
    batch = [];
    bytes = 0;
  };
  for (const path of actual) {
    const size = Buffer.byteLength(path, "utf8") + 1;
    assert.ok(size <= 8_000);
    if (bytes + size > 8_000) {
      verifyBatch();
    }
    batch.push(path);
    bytes += size;
  }
  verifyBatch();
  assert.deepEqual(projected.toSorted(), expected);
  assert.ok(actual.every((path) => !path.startsWith("tests/") && !path.startsWith("tools/")));
  assert.ok(actual.every((path) => !path.startsWith("scripts/")));
  assert.ok(
    actual.includes(
      "packages/docs-protocol/src/features/portable-documentation/application/docs-new.ts",
    ),
  );
});

function probeConfiguration(directory: string, name: string): string {
  const original = configuration(name);
  const path = join(directory, name);
  writeFileSync(
    path,
    JSON.stringify({ ...original, extends: original.extends.map((entry) => join(root, entry)) }),
  );
  return path;
}
function diagnostics(config: string, paths: readonly string[], cwd: string): readonly Diagnostic[] {
  return (
    JSON.parse(
      lint(["--config", config, "--disable-nested-config", "--format=json", ...paths], cwd),
    ) as { diagnostics: Diagnostic[] }
  ).diagnostics;
}

void test("native test typed lint uses its owning ES2024 context and rejects a downgraded context", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "TEST-native-lint-context-")));
  try {
    const config = probeConfiguration(directory, ".oxlintrc.type-aware.json");
    const testDirectory = join(directory, "packages", "probe", "tests");
    mkdirSync(testDirectory, { recursive: true });
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "junction");
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, target: "ES2020" },
        include: ["**/*.ts"],
      }),
    );
    const selected = "packages/probe/tests/context.ts";
    writeFileSync(join(directory, selected), "void Promise.withResolvers<boolean>();\n");
    const actualWrapperPath = "packages/engineering-foundation/tests/tsconfig.json";
    const wrapper: unknown = JSON.parse(readFileSync(join(root, actualWrapperPath), "utf8"));
    assert.ok(record(wrapper) && typeof wrapper.extends === "string");
    const derived = {
      ...wrapper,
      extends: resolve(dirname(join(root, actualWrapperPath)), wrapper.extends),
    };
    const nearest = join(testDirectory, "tsconfig.json");
    writeFileSync(nearest, JSON.stringify(derived));
    assert.deepEqual(diagnostics(config, [selected], directory), []);

    const options = record(wrapper.compilerOptions) ? wrapper.compilerOptions : {};
    writeFileSync(
      nearest,
      JSON.stringify({
        ...derived,
        compilerOptions: { ...options, target: "ES2020", lib: ["ES2020"], types: [] },
      }),
    );
    const actualNegativeDiagnostics = diagnostics(config, [selected], directory);
    assert.equal(
      actualNegativeDiagnostics.some((finding) => finding.code.includes("tsconfig-error")),
      false,
      JSON.stringify(actualNegativeDiagnostics),
    );
    assert.ok(
      actualNegativeDiagnostics.some((finding) => finding.code.includes("no-unsafe-call")),
      `The probe must reject unavailable ES2024 APIs when the owning context is downgraded: ${JSON.stringify(actualNegativeDiagnostics)}`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("syntax still rejects test syntax while typed production retains promise rules and strict budgets", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "TEST-repository-lint-scopes-")));
  try {
    const syntax = probeConfiguration(directory, ".oxlintrc.json");
    const typed = probeConfiguration(directory, ".oxlintrc.type-aware.json");
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: "ES2024" },
        include: ["**/*"],
      }),
    );
    const budget = [
      "function budget() {",
      "let value = 0;",
      ...Array.from({ length: 160 }, () => "value += 1;"),
      "return value;",
      "}",
      ...Array.from({ length: 350 }, () => "void budget();"),
    ].join("\n");
    for (const folder of ["tests", "packages/probe/src"]) {
      mkdirSync(join(directory, folder), { recursive: true });
      for (const extension of ["ts", "mts"]) {
        writeFileSync(
          join(directory, folder, `probe.${extension}`),
          `${budget}\nPromise.resolve(1);\nif (Number.NaN === 1) { throw new Error("bad"); }\n`,
        );
      }
    }
    const syntaxFindings = diagnostics(syntax, ["tests", "packages"], directory);
    const typedFindings = diagnostics(typed, ["packages/probe/src"], directory);
    for (const extension of ["ts", "mts"]) {
      const testMessages = syntaxFindings.filter((row) =>
        row.filename.endsWith(`tests/probe.${extension}`),
      );
      assert.ok(testMessages.some((row) => row.code.includes("use-isnan")));
      assert.equal(
        testMessages.some((row) => row.code.includes("no-floating-promises")),
        false,
      );
      for (const rule of ["max-lines", "max-lines-per-function"]) {
        assert.equal(
          testMessages.some((row) => row.code === `eslint(${rule})`),
          false,
        );
        assert.ok(
          typedFindings.some(
            (row) => row.filename.endsWith(`probe.${extension}`) && row.code === `eslint(${rule})`,
          ),
        );
      }
      assert.ok(
        typedFindings.some(
          (row) =>
            row.filename.endsWith(`probe.${extension}`) &&
            row.code.includes("no-floating-promises"),
        ),
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
