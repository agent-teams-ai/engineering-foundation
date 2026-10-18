import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { qualifyPackedNativePackage } from "../scripts/native-package-types-cli.ts";
import { qualifyNativePackageArchive } from "../scripts/native-package-types.ts";
import { tarArchive } from "./pack-publishable-artifacts-support.mjs";

const packageName = "@qualification/esm";
interface Fixture {
  manifest: Record<string, unknown>;
  files: Record<string, string>;
}

function fixture(): Fixture {
  return { manifest: { name: packageName, version: "0.1.0", type: "module",
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./package.json": "./package.json" } },
  files: { "dist/index.d.ts": "export declare const value: number;\n", "dist/index.js": "export const value = 1;\n" } };
}

function archive(input: Fixture, extraEntries: readonly { name: string; data: Buffer; type?: string }[] = []): Buffer {
  return tarArchive([
    { name: "package/package.json", data: Buffer.from(JSON.stringify(input.manifest)) },
    ...Object.entries(input.files).map(([path, text]) => ({ name: `package/${path}`, data: Buffer.from(text) })),
    ...extraEntries,
  ]);
}

function rejects(change: (input: Fixture) => void, expected: RegExp): void {
  const input = fixture();
  change(input);
  assert.throws(() => qualifyNativePackageArchive(archive(input), packageName), expected);
}

// Independent fixture map for all twelve ATTW problem classes. CJS-origin
// file diagnostics are excluded by rejecting their checked input premises;
// CJSResolvesToESM retains the existing esm-only profile's ignored CJS mode.
const problemFixtures = [
  { kind: "NoResolution", change: (input: Fixture) => { delete input.files["dist/index.d.ts"]; }, expected: /missing from the archive/u },
  { kind: "UntypedResolution", change: (input: Fixture) => { input.manifest["exports"] = { ".": { types: "./dist/index.js", import: "./dist/index.js" } }; }, expected: /unsupported declaration target/u },
  { kind: "FalseCJS", change: (input: Fixture) => { input.files["dist/cjs.d.cts"] = "export declare const value: number;"; }, expected: /unsupported code file/u },
  { kind: "FalseESM", change: (input: Fixture) => { input.files["dist/cjs.cjs"] = "exports.value = 1;"; }, expected: /unsupported code file/u },
  { kind: "NamedExports", change: (input: Fixture) => { input.files["dist/index.js"] = "module.exports = (() => ({ value: 1 }))();"; }, expected: /required ESM format or explicit module syntax/u },
  { kind: "FallbackCondition", change: (input: Fixture) => { input.manifest["exports"] = { ".": { types: "./dist/missing.d.ts", import: "./dist/index.js" } }; }, expected: /missing from the archive/u },
  { kind: "CJSOnlyExportsDefault", change: (input: Fixture) => { input.files["dist/index.js"] = "exports.__esModule = true; exports.default = function value() {};"; }, expected: /required ESM format or explicit module syntax/u },
  { kind: "FalseExportDefault", change: (input: Fixture) => { input.files["dist/index.d.ts"] = "export default function value(): void;"; input.files["dist/index.js"] = "module.exports = function value() {};"; }, expected: /required ESM format or explicit module syntax/u },
  { kind: "MissingExportEquals", change: (input: Fixture) => { input.files["dist/index.d.ts"] = "export default function value(): void;"; input.files["dist/index.js"] = "function value() {} module.exports = value; module.exports.default = value;"; }, expected: /required ESM format or explicit module syntax/u },
  { kind: "UnexpectedModuleSyntax", change: (input: Fixture) => { input.files["dist/index.js"] = "export const value = ;"; }, expected: /TS\d+:/u },
  { kind: "InternalResolutionError", change: (input: Fixture) => { input.files["dist/index.d.ts"] = "export { value } from './missing.js';"; }, expected: /unresolved own import/u },
] as const;

for (const row of problemFixtures) {
  test(`native package qualification retains ${row.kind} protection`, () => rejects(row.change, row.expected));
}

test("native package qualification retains the CJSResolvesToESM profile policy and both required modes", () => {
  const result = qualifyNativePackageArchive(archive(fixture()), packageName);
  assert.deepEqual(result, { packageName, packageVersion: "0.1.0", compilerVersion: "7.0.2",
    modes: ["node16-esm", "bundler"], typedEntrypoints: 1, codeFiles: 2, ownImports: 0 });
  assert.equal(problemFixtures.length + 1, 12);
});

test("native package qualification resolves relative, self and # imports in both modes", () => {
  const input = fixture();
  input.manifest["imports"] = { "#internal": "./dist/internal.js" };
  input.manifest["exports"] = { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./internal": { types: "./dist/internal.d.ts", import: "./dist/internal.js" } };
  input.files["dist/index.d.ts"] = `export { value } from '${packageName}/internal';\nexport type Internal = typeof import('#internal');`;
  input.files["dist/index.js"] = "export { value } from '#internal';\nimport './internal.js';";
  input.files["dist/internal.d.ts"] = "export declare const value: number;";
  input.files["dist/internal.js"] = "export const value = 1;";
  const result = qualifyNativePackageArchive(archive(input), packageName);
  assert.equal(result.typedEntrypoints, 2);
  assert.equal(result.ownImports, 8);
});

test("native package qualification rejects unresolved self and # declaration imports", () => {
  for (const reference of [`${packageName}/missing`, "#missing"]) {
    rejects(input => { input.files["dist/index.d.ts"] = `export type Missing = import('${reference}').Missing;`; }, /unresolved own import/u);
  }
});

test("native package qualification does not mistake an ambient module symbol for file resolution", () => {
  rejects(input => {
    input.files["dist/index.d.ts"] = `declare module '${packageName}/missing' { export interface Missing {} }\nexport type Missing = import('${packageName}/missing').Missing;`;
  }, /unresolved own import/u);
});

test("native package qualification rejects a path accepted only by Bundler", () => {
  rejects(input => {
    input.files["dist/index.d.ts"] = "export { value } from './internal';";
    input.files["dist/internal.d.ts"] = "export declare const value: number;";
  }, /unresolved own import/u);
});

test("native package qualification resolves JS runtime paths independently of declaration siblings", () => {
  rejects(input => {
    input.files["dist/index.js"] = "export { value } from './internal.js';";
    input.files["dist/internal.d.ts"] = "export declare const value: number;";
  }, /unresolved own runtime import/u);
});

test("native package qualification never admits legacy or alternate condition graphs", () => {
  for (const field of ["main", "module", "types", "typings", "typesVersions", "browser"]) {
    rejects(input => { input.manifest[field] = "./dist/index.js"; }, /unsupported legacy resolution field/u);
  }
  for (const value of [
    { import: "./dist/index.js", types: "./dist/index.d.ts" },
    { types: "./dist/index.d.ts", import: "./dist/index.js", require: "./dist/index.js" },
    { types: { default: "./dist/index.d.ts" }, import: "./dist/index.js" },
    ["./dist/index.js"],
  ]) {
    rejects(input => { input.manifest["exports"] = { ".": value }; }, /first types|relative package path|must be an object/u);
  }
  rejects(input => { input.manifest["exports"] = { "./dist/index": { types: "./dist/index.d.ts", import: "./dist/index.js" } }; }, /alternative legacy entrypoint/u);
  rejects(input => { input.files["index.js"] = "export const value = 1;"; }, /unsupported code file/u);
});

test("native package qualification rejects nested module scopes and export-equals declarations", () => {
  rejects(input => { input.files["dist/package.json"] = '{"type":"commonjs"}'; }, /nested package scope/u);
  rejects(input => { input.files["dist/index.d.ts"] = "declare function value(): void; export = value;"; }, /unsupported declaration export form/u);
  rejects(input => { input.manifest["type"] = "commonjs"; }, /type:module/u);
});

test("native package qualification explicitly excludes syntax-free ESM from its bounded domain", () => {
  rejects(input => { input.files["dist/index.js"] = "const internal = 1; void internal;"; }, /required ESM format or explicit module syntax/u);
});

test("native package qualification validates explicit JSON and bounded JSON wildcard members", () => {
  const input = fixture();
  input.manifest["exports"] = { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./schema.json": "./schemas/v1.json", "./schemas/*": "./schemas/*" };
  input.files["schemas/v1.json"] = '{"type":"object"}';
  assert.equal(qualifyNativePackageArchive(archive(input), packageName).typedEntrypoints, 1);
  input.files["schemas/readme.txt"] = "not JSON";
  assert.throws(() => qualifyNativePackageArchive(archive(input), packageName), /must identify JSON data/u);
});

test("native package qualification resolves packed JSON wildcard self-imports and rejects missing members", () => {
  const input = fixture();
  input.manifest["exports"] = { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./schemas/*": "./schemas/*" };
  input.files["schemas/v1.json"] = '{"type":"object"}';
  input.files["dist/index.js"] = `import schema from '${packageName}/schemas/v1.json' with { type: 'json' }; export const value = schema;`;
  assert.equal(qualifyNativePackageArchive(archive(input), packageName).ownImports, 2);
  input.files["dist/index.js"] = `import schema from '${packageName}/schemas/missing.json' with { type: 'json' }; export const value = schema;`;
  assert.throws(() => qualifyNativePackageArchive(archive(input), packageName), /unresolved own import/u);
});

test("native package qualification gives exact exports precedence over data wildcards", () => {
  const input = fixture();
  input.manifest["exports"] = { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./schemas/*": "./schemas/*", "./schemas/v1.json": "./schemas/v2.json" };
  // No v1.json exists: success requires selecting the exact export's v2 target.
  input.files["schemas/v2.json"] = '{"type":"object"}';
  input.files["dist/index.js"] = `import schema from '${packageName}/schemas/v1.json' with { type: 'json' }; export const value = schema;`;
  assert.equal(qualifyNativePackageArchive(archive(input), packageName).ownImports, 2);
});

test("native package qualification rejects overlapping wildcard resolution domains", () => {
  rejects(input => {
    input.manifest["exports"] = { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./schemas/*": "./schemas/*", "./schemas/*.json": "./schemas/*.json" };
    input.files["schemas/v1.json"] = '{}';
  }, /overlapping data wildcard exports/u);
});

test("native package qualification rejects identity drift, duplicate members and special entries", () => {
  assert.throws(() => qualifyNativePackageArchive(archive(fixture()), "@qualification/other"), /package name differs/u);
  assert.throws(() => qualifyNativePackageArchive(archive(fixture(), [
    { name: "package/dist/index.js", data: Buffer.from("export {};" ) },
  ]), packageName), /duplicate archive member/u);
  assert.throws(() => qualifyNativePackageArchive(archive(fixture(), [
    { name: "package/link", data: Buffer.alloc(0), type: "2" },
  ]), packageName), /unsupported archive member/u);
});

test("native package qualification cannot resolve an own file from the real filesystem", async t => {
  const root = await mkdtemp(join(tmpdir(), "native-package-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, "outside.d.ts");
  await writeFile(outside, "export interface Outside {}\n");
  rejects(input => { input.files["dist/index.d.ts"] = `export type Outside = import(${JSON.stringify(outside)}).Outside;`; }, /unresolved own import/u);
});

test("native package CLI qualifies real packed bytes without running package lifecycle scripts", async t => {
  const root = await mkdtemp(join(tmpdir(), "native-package-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = fixture();
  input.manifest["scripts"] = { prepack: "node -e \"throw new Error('lifecycle must not execute')\"" };
  input.manifest["files"] = ["dist/index.d.ts", "dist/index.js"];
  await writeFile(join(root, "package.json"), JSON.stringify(input.manifest));
  await mkdir(join(root, "dist"));
  for (const [path, text] of Object.entries(input.files)) { await writeFile(join(root, path), text); }
  assert.equal((await qualifyPackedNativePackage(root)).typedEntrypoints, 1);
  assert.deepEqual((await readdir(root)).toSorted(), ["dist", "package.json"]);
  input.manifest["files"] = ["dist/index.js"];
  await writeFile(join(root, "package.json"), JSON.stringify(input.manifest));
  await assert.rejects(qualifyPackedNativePackage(root), /missing from the archive/u);
  assert.match(await readFile(join(root, "dist/index.d.ts"), "utf8"), /value/u);
});
