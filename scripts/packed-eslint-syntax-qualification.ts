import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { runCommand } from "./pack-test-support.mjs";

const legacyTripwire = `
import { registerHooks } from "node:module";
const blocked = ["typescript", "typescript-eslint", "@typescript-eslint/parser", "@typescript-eslint/typescript-estree", "@typescript-eslint/eslint-plugin", "@typescript-eslint/utils"];
const forbidden = (specifier) => blocked.some((name) => specifier === name || specifier.startsWith(name + "/") || specifier.includes("/node_modules/" + name + "/"));
registerHooks({ resolve(specifier, context, next) {
  if (forbidden(specifier)) throw new Error("PACKED_LEGACY_INITIALIZER_BLOCKED:" + specifier);
  const result = next(specifier, context);
  if (forbidden(result.url)) throw new Error("PACKED_LEGACY_INITIALIZER_BLOCKED:" + result.url);
  return result;
} });
`;

const lazyRootTripwire = `
import { registerHooks } from "node:module";
const blocked = ["eslint", "eslint-parser-oxc", "oxc-parser", "typescript", "@typescript-eslint/scope-manager"];
const forbidden = (specifier) => specifier.includes("/features/eslint-syntax/") || blocked.some((name) => specifier === name || specifier.startsWith(name + "/") || specifier.includes("/node_modules/" + name + "/"));
registerHooks({ resolve(specifier, context, next) {
  if (forbidden(specifier)) throw new Error("PACKED_UNEXPECTED_SYNTAX_LOAD:" + specifier);
  const result = next(specifier, context);
  if (forbidden(result.url)) throw new Error("PACKED_UNEXPECTED_SYNTAX_LOAD:" + result.url);
  return result;
} });
`;

// These literal consumer programs exercise the packed public JavaScript and declarations.
const runtimeConsumer = `
import assert from "node:assert/strict";
import { Linter } from "eslint";
import { configs, parser, plugin } from "stack-toolchain/eslint-syntax";
assert.equal(configs.recommended[0].languageOptions.parser, parser);
assert.equal(plugin.meta.name, "stack-toolchain/eslint-syntax");
assert.deepEqual(Object.keys(plugin.rules).sort(), [
  "ban-ts-comment", "no-array-constructor", "no-duplicate-enum-values",
  "no-empty-object-type", "no-explicit-any", "no-extra-non-null-assertion",
  "no-misused-new", "no-namespace", "no-non-null-asserted-optional-chain",
  "no-require-imports", "no-this-alias", "no-unnecessary-type-constraint",
  "no-unsafe-declaration-merging", "no-unsafe-function-type", "no-unused-expressions",
  "no-unused-vars", "no-wrapper-object-types", "prefer-as-const",
  "prefer-namespace-keyword", "triple-slash-reference",
].sort());
assert.equal(configs.recommended.length, 3);
const linter = new Linter();
const config = [...configs.recommended, { files: ["**/*.ts"] }];
assert.deepEqual(linter.verify("export const ready: number = 1;", config, { filename: "accepted.ts" }), []);
const diagnostics = linter.verify("const unused: any = 1;", config, { filename: "rejected.ts" });
assert.deepEqual(diagnostics.map(({ ruleId, messageId, line, column, endLine, endColumn }) => ({ ruleId, messageId, line, column, endLine, endColumn })).sort((a, b) => a.ruleId.localeCompare(b.ruleId)), [
  { ruleId: "@typescript-eslint/no-explicit-any", messageId: "unexpectedAny", line: 1, column: 15, endLine: 1, endColumn: 18 },
  { ruleId: "@typescript-eslint/no-unused-vars", messageId: "unusedVar", line: 1, column: 7, endLine: 1, endColumn: 13 },
]);
const fixed = linter.verifyAndFix('export const token = "ok" as "ok";', config, { filename: "fixed.ts" });
assert.equal(fixed.fixed, true);
assert.equal(fixed.output, 'export const token = "ok" as const;');
assert.deepEqual(fixed.messages, []);
console.log("packed-eslint-syntax-runtime: PASS");
`;

const publicTypeConsumer = `
import { configs, parser, plugin } from "stack-toolchain/eslint-syntax";
import type { Linter } from "eslint";
export const configuration: Linter.Config[] = [
  ...configs.recommended,
  { languageOptions: { parser }, plugins: { retained: plugin } },
];
`;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an installed package metadata record");
  }
  return Object.fromEntries(Object.entries(value));
}

async function installedVersion(manifest: string, name: string): Promise<string> {
  const metadata = record(JSON.parse(await readFile(manifest, "utf8")));
  assert.equal(metadata["name"], name);
  const version = metadata["version"];
  assert.ok(typeof version === "string");
  return version;
}

function diagnosticOutput(error: unknown): string {
  assert.ok(error instanceof Error && "stdout" in error && "stderr" in error);
  assert.ok("signal" in error && error.signal === null, "Signal termination is not a diagnostic");
  assert.ok("code" in error && typeof error.code === "number" && error.code !== 0);
  assert.ok(typeof error.stdout === "string");
  assert.ok(typeof error.stderr === "string");
  return error.stdout + error.stderr;
}

async function qualifyRuntime(root: string): Promise<void> {
  await writeFile(join(root, "deny-legacy.ts"), legacyTripwire);
  await writeFile(join(root, "runtime.mjs"), runtimeConsumer);
  const guarded = ["--import", join(root, "deny-legacy.ts")];
  const runtime = await runCommand(process.execPath, [...guarded, "runtime.mjs"], root);
  assert.match(runtime.stdout, /packed-eslint-syntax-runtime: PASS/u);
  for (const expression of [
    'await import("typescript");',
    'import { createRequire } from "node:module"; createRequire(import.meta.url)("@typescript-eslint/eslint-plugin");',
  ]) {
    await assert.rejects(
      runCommand(process.execPath, [...guarded, "--input-type=module", "-e", expression], root),
      (error: unknown) => /PACKED_LEGACY_INITIALIZER_BLOCKED:/u.test(diagnosticOutput(error)),
    );
  }
}

async function qualifyLazyRoot(root: string): Promise<void> {
  await writeFile(join(root, "deny-syntax.ts"), lazyRootTripwire);
  const program = `
    import assert from "node:assert/strict";
    import * as api from "stack-toolchain";
    assert.equal(typeof api.runCommand, "function");
  `;
  await runCommand(
    process.execPath,
    ["--import", join(root, "deny-syntax.ts"), "--input-type=module", "-e", program],
    root,
  );
}

async function qualifyPublicTypes(root: string, compiler: string): Promise<void> {
  await writeFile(join(root, "positive.ts"), publicTypeConsumer);
  const config = {
    files: ["positive.ts"],
    compilerOptions: {
      module: "NodeNext",
      target: "ES2024",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noImplicitReturns: true,
      noImplicitOverride: true,
      noPropertyAccessFromIndexSignature: true,
    },
  };
  await writeFile(join(root, "tsconfig.json"), JSON.stringify(config));
  const args = [compiler, "-p", "tsconfig.json", "--pretty", "false"];
  await runCommand(process.execPath, args, root);
  await writeFile(
    join(root, "negative.ts"),
    'import type { Linter } from "eslint";\nconst invalid: Linter.Config = { languageOptions: { parser: 42 } };\nvoid invalid;\n',
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({ ...config, files: ["negative.ts"] }),
  );
  await assert.rejects(runCommand(process.execPath, args, root), (error: unknown) =>
    /negative\.ts\(2,\d+\): error TS2322:/u.test(diagnosticOutput(error)),
  );
}

async function withInstalledModules(
  consumerRoot: string,
  qualify: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(dirname(resolve(consumerRoot)), "TEST-packed-eslint-syntax-"));
  try {
    await symlink(
      resolve(consumerRoot, "node_modules"),
      join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}\n');
    await qualify(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Qualifies the installed public export with an explicit supported ESLint host. */
export async function qualifyInstalledEslintSyntax(consumerRoot: string): Promise<void> {
  const installed = createRequire(join(resolve(consumerRoot), "package.json"));
  assert.equal(
    await installedVersion(installed.resolve("eslint/package.json"), "eslint"),
    "10.3.0",
  );
  const toolchain = createRequire(installed.resolve("stack-toolchain/package.json"));
  const compilerManifest = toolchain.resolve("typescript/package.json");
  assert.equal(await installedVersion(compilerManifest, "typescript"), "7.0.2");
  await withInstalledModules(consumerRoot, async (root) => {
    await qualifyRuntime(root);
    await qualifyLazyRoot(root);
    await qualifyPublicTypes(root, join(dirname(compilerManifest), "bin/tsc"));
  });
}

/** Proves lazy initialization; ordinary no-explicit-host installs are separate cases. */
export async function qualifyInstalledEslintRoot(consumerRoot: string): Promise<void> {
  await withInstalledModules(consumerRoot, qualifyLazyRoot);
}

export interface EslintSyntaxArtifactExpectation {
  readonly packageVersion: string;
  readonly notices: string;
  readonly provenance: string;
}

/** Checks the actual installed candidate, including the notices shipped with retained source. */
export async function verifyInstalledEslintSyntaxArtifacts(
  consumerRoot: string,
  expected: EslintSyntaxArtifactExpectation,
): Promise<void> {
  const installed = createRequire(join(resolve(consumerRoot), "package.json"));
  const manifest = await realpath(installed.resolve("stack-toolchain/package.json"));
  const modules = await realpath(join(consumerRoot, "node_modules"));
  assert.ok(manifest.startsWith(modules + sep), "Candidate must resolve from this installation");
  assert.equal(await installedVersion(manifest, "stack-toolchain"), expected.packageVersion);
  const metadata = record(JSON.parse(await readFile(manifest, "utf8")));
  assert.equal(metadata["license"], "Apache-2.0");
  const dependencies = record(metadata["dependencies"]);
  assert.equal(dependencies["typescript"], "7.0.2");
  assert.equal(dependencies["eslint-parser-oxc"], "0.1.1");
  assert.equal(dependencies["@typescript-eslint/scope-manager"], "8.73.0");
  assert.equal(dependencies["@eslint/core"], "1.2.1");
  assert.equal(record(metadata["peerDependencies"])["eslint"], "10.3.0");
  assert.equal(record(record(metadata["peerDependenciesMeta"])["eslint"])["optional"], true);
  const root = dirname(manifest);
  const notices = await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  const provenance = await readFile(join(root, "eslint-syntax-provenance.json"), "utf8");
  assert.equal(notices, expected.notices);
  assert.equal(provenance, expected.provenance);
  for (const text of [
    "Permission is hereby granted",
    "Copyright (c) 2019 typescript-eslint",
    "Copyright OpenJS Foundation",
  ]) {
    assert.ok(notices.includes(text), text);
  }
  const ledger = record(JSON.parse(provenance));
  const upstream = record(ledger["upstream"]);
  assert.equal(upstream["version"], "8.59.1");
  assert.equal(upstream["commit"], "52457932e5507b5ca01e720a541f3f8d01e09b9d");
  assert.equal(record(ledger["eslintCore"])["version"], "10.3.0");
  assert.equal(record(ledger["typeContract"])["version"], "8.73.0");
  assert.equal(record(ledger["scopeContract"])["version"], "8.73.0");
  const files: unknown = ledger["files"];
  assert.ok(Array.isArray(files));
  const rules = files
    .map(record)
    .filter(
      (entry) =>
        typeof entry["source"] === "string" &&
        entry["source"].startsWith("packages/eslint-plugin/src/rules/"),
    );
  assert.equal(rules.length, 20);
  for (const entry of rules) {
    assert.ok(typeof entry["sha256"] === "string" && /^[a-f0-9]{64}$/u.test(entry["sha256"]));
    assert.ok(typeof entry["gitBlob"] === "string" && /^[a-f0-9]{40}$/u.test(entry["gitBlob"]));
  }
  for (const path of ["dist/eslint-syntax.js", "dist/eslint-syntax.d.ts"]) {
    assert.ok((await readFile(join(root, path))).length > 0, path);
  }
}
