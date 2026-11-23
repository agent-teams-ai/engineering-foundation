import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scopeApi =
  "class Visitor { visit() {} visitPattern() {} } class PatternVisitor { visit() {} } class ImplicitLibVariable {} class ScopeManager { acquire() {} getDeclaredVariables() {} } module.exports = { Visitor, PatternVisitor, ImplicitLibVariable, ScopeManager };";

interface FixtureOptions {
  scopeVersion?: string;
  parserVersion?: string;
  duplicateScope?: boolean;
  invalidScopeApi?: boolean;
  invalidParserApi?: boolean;
  foreignScopeResult?: boolean;
}

function packageFixture(root: string, name: string, version: string, source: string): void {
  const directory = join(root, "node_modules", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name, version, main: "index.cjs" }),
  );
  writeFileSync(join(directory, "index.cjs"), source);
}

function admissionFixture(options: FixtureOptions): string {
  const root = mkdtempSync(join(tmpdir(), "TEST-eslint-admission-"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  for (const name of ["parser-runtime.js", "scope-runtime.js", "scope-contract.js"]) {
    copyFileSync(
      new URL(`../dist/features/eslint-syntax/adapters/${name}`, import.meta.url),
      join(root, name),
    );
  }
  const marker = (name: string) =>
    `require('node:fs').writeFileSync(${JSON.stringify(join(root, name))}, 'initialized');`;
  packageFixture(
    root,
    "@typescript-eslint/scope-manager",
    options.scopeVersion ?? "8.73.0",
    marker("scope-started") + (options.invalidScopeApi ? "module.exports = {};" : scopeApi),
  );
  packageFixture(
    root,
    "eslint-parser-oxc",
    options.parserVersion ?? "0.1.1",
    marker("parser-started") +
      (options.invalidParserApi
        ? "module.exports = {};"
        : options.foreignScopeResult
          ? "module.exports = { parseForESLint() { return { ast: { type: 'Program' }, scopeManager: {}, visitorKeys: {}, services: {} }; } };"
          : "module.exports = { parseForESLint() { return {}; } };"),
  );
  if (options.duplicateScope) {
    packageFixture(
      join(root, "node_modules/eslint-parser-oxc"),
      "@typescript-eslint/scope-manager",
      "8.73.0",
      marker("duplicate-started") + scopeApi,
    );
  }
  return root;
}

function expectRejection(root: string, error: RegExp, parse = false): void {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      parse
        ? 'const { parser } = await import("./parser-runtime.js"); parser.parseForESLint("value;");'
        : 'await import("./parser-runtime.js");',
    ],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(result.stderr, error);
}

const rejected = [
  {
    name: "scope version",
    options: { scopeVersion: "8.72.0" },
    error: /qualified scope-manager 8\.73\.0/u,
    scopeStarted: false,
  },
  {
    name: "parser version",
    options: { parserVersion: "0.1.0" },
    error: /qualified public eslint-parser-oxc 0\.1\.1/u,
    scopeStarted: true,
  },
  {
    name: "second physical scope",
    options: { duplicateScope: true },
    error: /same qualified scope-manager before initialization/u,
    scopeStarted: true,
  },
  {
    name: "missing scope constructors",
    options: { invalidScopeApi: true },
    error: /constructor contract is missing/u,
    scopeStarted: true,
  },
] satisfies { name: string; options: FixtureOptions; error: RegExp; scopeStarted: boolean }[];

for (const fixture of rejected) {
  void test(`admission rejects ${fixture.name} before parser or divergent scope initialization`, () => {
    const root = admissionFixture(fixture.options);
    try {
      expectRejection(root, fixture.error);
      assert.equal(existsSync(join(root, "scope-started")), fixture.scopeStarted);
      assert.equal(existsSync(join(root, "parser-started")), false);
      assert.equal(existsSync(join(root, "duplicate-started")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

void test("admission validates the public parser API after qualified initialization", () => {
  const root = admissionFixture({ invalidParserApi: true });
  try {
    expectRejection(root, /native parser API is missing/u);
    assert.equal(existsSync(join(root, "parser-started")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("admission rejects a foreign scope-manager result after qualified initialization", () => {
  const root = admissionFixture({ foreignScopeResult: true });
  try {
    expectRejection(root, /foreign scope-manager instance/u, true);
    assert.equal(existsSync(join(root, "scope-started")), true);
    assert.equal(existsSync(join(root, "parser-started")), true);
    assert.equal(existsSync(join(root, "duplicate-started")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
