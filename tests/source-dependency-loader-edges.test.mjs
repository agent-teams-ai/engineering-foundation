import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(repositoryRoot, "packages", "engineering-foundation");
const distRoot = process.env.ENGINEERING_FOUNDATION_DIST_ROOT ?? join(packageRoot, "dist");
const { OxcSourceDependencyParser } = await import(pathToFileURL(join(
  distRoot,
  "capabilities/source-dependencies/adapters/outbound/oxc/oxc-source-dependency-parser.js",
)).href);

function observe(source, path = "packages/app/src/index.mts") {
  const parsed = new OxcSourceDependencyParser().parse({ path, source });
  return {
    parseErrorCount: parsed.parseErrorCount,
    references: parsed.references.map(({ kind, specifier }) => `${kind}:${specifier}`),
    unresolved: parsed.unresolved.map(({ kind }) => kind),
  };
}

test("loader syntax matrix recognizes only supported Node lexical origins", () => {
  const source = `
import { createRequire as makeRequire } from "node:module";
import * as Module from "module";
import { createRequire as userFactory } from "user-module";
const ambientAlias = require;
const aliasChain = ambientAlias;
const importedLoader = makeRequire(import.meta.url);
const namespaceLoader = Module.createRequire(import.meta.url);
require("direct");
module.require("module-member");
aliasChain("ambient-alias");
importedLoader("named-create-require");
namespaceLoader("namespace-create-require");
userFactory(import.meta.url)("user-factory");
({ require() {} }).require("user-member");
`;
  assert.deepEqual(observe(source), {
    parseErrorCount: 0,
    references: [
      "static:node:module",
      "static:module",
      "static:user-module",
      "commonjs:direct",
      "commonjs:module-member",
      "commonjs:ambient-alias",
      "commonjs:named-create-require",
      "commonjs:namespace-create-require",
    ],
    unresolved: [],
  });
});

test("shadowed APIs remain user-owned and reassigned loaders retain opaque evidence", () => {
  const source = `
function shadowedParameter(require) { require("parameter"); }
function shadowedModule(module) { module.require("member"); }
{
  const require = (value) => value;
  require("block-local");
}
{
  const module = { require(value) { return value; } };
  module.require("block-member");
}
let changed = require;
changed = (value) => value;
changed("reassigned");
require("ambient-still-visible");
`;
  assert.deepEqual(observe(source, "packages/app/src/index.cts"), {
    parseErrorCount: 0,
    references: ["commonjs:ambient-still-visible"],
    unresolved: ["commonjs"],
  });

  assert.deepEqual(observe(`
declare const require: (value: string) => unknown;
require("ambient-declaration");
`, "packages/app/src/types.ts"), {
    parseErrorCount: 0,
    references: [],
    unresolved: [],
  });
});

test("createRequire preserves importer base and refuses to guess a different base", () => {
  const source = `
import { createRequire } from "node:module";
const fromImporter = createRequire(import.meta.url);
const fromOtherFile = createRequire("/different/base/entry.cjs");
fromImporter("same-specifier");
fromOtherFile("same-specifier");
fromImporter(variableSpecifier);
`;
  assert.deepEqual(observe(source), {
    parseErrorCount: 0,
    references: ["static:node:module", "commonjs:same-specifier"],
    unresolved: ["commonjs", "commonjs"],
  });
});

const bindingCases = [
  ["ambient function", 'declare function require(s: string): unknown; require("user");', [], []],
  ["loop scope", 'for (const require of users) { require("user"); } require("outer");', ["commonjs:outer"], []],
  ["switch scope", 'switch (require("selector")) { case 0: const require = user; require("user"); } require("outer");', ["commonjs:selector", "commonjs:outer"], []],
  ["named class expression", 'const C = class require { method() { require("user"); } }; require("outer");', ["commonjs:outer"], []],
  ["namespace scope", 'namespace Local { const require = user; require("user"); } require("outer");', ["commonjs:outer"], []],
  ["ambient namespace", 'declare namespace require { function call(s: string): void; } require("user");', [], []],
  ["parameter default excludes body var", 'function f(x = require("default")) { var require = user; require("user"); }', ["commonjs:default"], []],
  ["unrelated destructuring", 'const { resolve: load } = require; load("user"); const [other] = require; other("user");', [], []],
  ["module destructuring", 'const { require: load } = module; load("edge");', [], ["commonjs"]],
  ["static computed members", 'module["require"]("edge"); require("node:module")["createRequire"](import.meta.url)("other");', ["commonjs:edge", "commonjs:node:module", "commonjs:other"], []],
  ["TS builtin namespace", 'import Module = require("node:module"); Module.createRequire(import.meta.url)("edge");', ["import-equals:node:module", "commonjs:edge"], []],
  ["builtin loader", 'process.getBuiltinModule("module").createRequire(import.meta.url)("edge");', ["commonjs:module", "commonjs:edge"], []],
  ["shadowed builtin loader", 'function f(process) { process.getBuiltinModule("module").createRequire(import.meta.url)("user"); }', [], []],
  ["writes retain evidence", 'let load = require; load("before"); load = user; load("after");', [], ["commonjs", "commonjs"]],
  ["destructuring write", 'let load = require; ({ load } = user); load("opaque");', [], ["commonjs"]],
  ["assignment origin", 'let load; load = require; load("opaque");', [], ["commonjs"]],
  ["loop write", 'let load = require; for (load of users) {} load("opaque");', [], ["commonjs"]],
  ["member mutation", 'const Module = require("module"); Module.createRequire = user; Module.createRequire(import.meta.url)("opaque");', ["commonjs:module"], ["commonjs"]],
  ["hoisted var redeclaration", 'var load = require; var load; load("edge");', ["commonjs:edge"], []],
  ["type alias is not a value binding", 'type require = string; require("edge");', ["commonjs:edge"], []],
];
bindingCases.push(
  ["named default builtin import", 'import { default as Module } from "node:module"; Module.createRequire(import.meta.url)("edge");', ["static:node:module", "commonjs:edge"], []],
  ["type import is not a value binding", 'import type { require } from "types"; require("edge");', ["static-type:types", "commonjs:edge"], []],
  ["type import equals is not a value binding", 'import type require = require("types"); require("edge");', ["import-equals-type:types", "commonjs:edge"], []],
  ["destructuring assignment origin", 'let load; ({ require: load } = module); load("opaque");', [], ["commonjs"]],
  ["default destructuring origin", 'const { load = require } = user; load("opaque");', [], ["commonjs"]],
  ["parameter default origin", 'function f(load = require) { load("opaque"); }', [], ["commonjs"]],
  ["parameter destructuring origin", 'function f({ require: load } = module) { load("opaque"); }', [], ["commonjs"]],
  ["non-builtin getter argument", 'process.getBuiltinModule("user-package");', [], ["commonjs"]],
  ["reflective calls", 'require.call(null, "opaque"); module.require.apply(module, ["opaque"]); const load = require.bind(null); load("opaque");', [], ["commonjs", "commonjs", "commonjs"]],
  ["namespace alias member mutation", 'const Module = require("module"); const other = Module; other.createRequire = user; Module.createRequire(import.meta.url)("opaque");', ["commonjs:module"], ["commonjs"]],
  ["alias reassignment leaves original intact", 'const Module = require("module"); let other = Module; other = user; Module.createRequire(import.meta.url)("edge");', ["commonjs:module", "commonjs:edge"], []],
  ["catch binding", 'try {} catch (require) { require("user"); } require("outer");', ["commonjs:outer"], []],
  ["hoisted function binding", 'function f() { require("user"); function require(x) { return x; } }', [], []],
  ["optional member and call", 'module?.require?.("edge");', ["commonjs:edge"], []],
  ["URL bases remain opaque", 'import { createRequire } from "module"; createRequire("file:///elsewhere/main.js")("same"); createRequire(new URL("./other.js", import.meta.url))("same");', ["static:module"], ["commonjs", "commonjs"]],
  ["factory shadowing", 'import { createRequire } from "module"; function f(createRequire) { createRequire(import.meta.url)("user"); }', ["static:module"], []],
);
bindingCases.push(
  ["mixed loader and factory writes", 'import { createRequire } from "module"; let load = require; load = createRequire; load("opaque");', ["static:module"], ["commonjs"]],
  ["mixed namespace and loader writes", 'let value = require("module"); value = require; value.createRequire(import.meta.url)("opaque");', ["commonjs:module"], ["commonjs"]],
  ["conditional loader alias", 'const load = flag ? require : user; load("opaque");', [], ["commonjs"]],
  ["logical loader alias", 'const load = user || require; load("opaque");', [], ["commonjs"]],
  ["sequence loader", '(0, require)("edge");', ["commonjs:edge"], []],
);
bindingCases.push(["cyclic alias provenance", 'let a; let b; a = b; a = require; b = a; a("opaque"); b("opaque");', [], ["commonjs", "commonjs"]]);
bindingCases.push(
  ["default builtin import", 'import Module from "node:module"; Module.createRequire(import.meta.url)("edge");', ["static:node:module", "commonjs:edge"], []],
  ["imported builtin getter", 'import { getBuiltinModule as get } from "node:process"; get("module").createRequire(import.meta.url)("edge");', ["static:node:process", "commonjs:module", "commonjs:edge"], []],
  ["builtin destructured factory", 'const { createRequire: make } = require("node:module"); make(import.meta.url)("edge");', ["commonjs:node:module", "commonjs:edge"], []],
  ["update and deletion", 'let load = require; load++; load("opaque"); delete module.require; module.require("opaque");', [], ["commonjs", "commonjs"]],
  ["static block var stays local", 'class C { static { var require = user; require("user"); } } require("outer");', ["commonjs:outer"], []],
  ["spread and absent argument", 'require(...args); module.require();', [], ["commonjs", "commonjs"]],
);
for (const [name, source, references, unresolved] of bindingCases) {
  test(`lexical matrix: ${name}`, () => {
    assert.deepEqual(observe(source), { parseErrorCount: 0, references, unresolved });
  });
}

test("opaque bases and provenance remain graph evidence when commonjs is allowed", async () => {
  const modulePath = "capabilities/source-dependencies/application/use-cases/build-observed-source-graph.js";
  const { buildObservedSourceGraph } = await import(pathToFileURL(join(distRoot, modulePath)).href);
  const source = `import { createRequire } from "node:module";
createRequire(import.meta.url)("same-specifier");
createRequire("/other/index.cjs")("same-specifier");
const detached = module.require; detached("same-specifier");
function f(load = require) { var load; load("same-specifier"); }`;
  const file = { path: "packages/app/src/index.mts", source };
  const workspacePackage = { name: "@fixture/app", rootPath: "packages/app",
    manifestPath: "packages/app/package.json" };
  const boundary = { id: "app", allowedRuntimeReferences: ["commonjs"] };
  const resolutions = [];
  const graph = buildObservedSourceGraph({
    inventory: { packages: [workspacePackage] }, allSourceFiles: [file],
    classifiedFiles: [{ ...file, workspacePackage, boundary,
      parsed: new OxcSourceDependencyParser().parse(file) }],
    resolver: { resolve({ reference }) {
      resolutions.push(reference.specifier);
      return { kind: "builtin", specifier: reference.specifier };
    } },
  });
  assert.deepEqual(resolutions, ["node:module", "same-specifier"],
    "unrepresentable base must never reach the importer-relative resolver");
  assert.deepEqual(graph.edges.map(({ kind, specifier, mode }) => ({ kind, specifier, mode })), [
    { kind: "commonjs", specifier: "same-specifier", mode: "runtime" },
    { kind: "static", specifier: "node:module", mode: "runtime" },
  ]);
  assert.deepEqual(graph.unresolvedRuntimeReferences.map((opaque) => ({
    kind: opaque.kind, source: source.slice(opaque.start, opaque.end),
  })), [
    { kind: "commonjs", source: 'createRequire("/other/index.cjs")("same-specifier")' },
    { kind: "commonjs", source: 'detached("same-specifier")' },
    { kind: "commonjs", source: 'load("same-specifier")' },
  ]);
  assert.ok(Object.isFrozen(graph.unresolvedRuntimeReferences));
});

test("loader source spans and parse-error evidence stay fail closed", () => {
  const source = 'const text = "é😀"; module.require("literal"); require(variable);';
  const parser = new OxcSourceDependencyParser();
  const parsed = parser.parse({ path: "source.cts", source });
  assert.equal(source.slice(parsed.references[0].start, parsed.references[0].end), '"literal"');
  assert.equal(source.slice(parsed.unresolved[0].start, parsed.unresolved[0].end), "require(variable)");
  const broken = parser.parse({ path: "source.cts", source: `${source}\nconst = ;` });
  assert.ok(broken.parseErrorCount > 0);
  assert.deepEqual(broken.references, []);
  assert.deepEqual(broken.unresolved, []);
});

test("dense cyclic aliases converge without losing possible loader origins", () => {
  const names = Array.from({ length: 24 }, (_, index) => `load${index}`);
  const source = `let ${names.join(", ")};\n${names.map((name, index) =>
    `${name} = load${(index + 1) % names.length}; ${name} = load${(index + 2) % names.length};`).join("\n")}
load0 = require;
${names.map((name) => `${name}("opaque");`).join("\n")}`;
  assert.deepEqual(observe(source), { parseErrorCount: 0, references: [],
    unresolved: Array.from({ length: 24 }, () => "commonjs") });
});

test("published normalized kinds outside loader corrections preserve their meaning", () => {
  const source = `import value from "static";
import type { Type } from "static-type";
export { value } from "export";
export type { Type } from "export-type";
import alias = require("import-equals");
import type typeAlias = require("import-equals-type");
type Query = import("type-query").Value;
import("dynamic");
require("commonjs");`;
  assert.deepEqual(observe(source, "all-kinds.cts"), {
    parseErrorCount: 0,
    references: ["static:static", "static-type:static-type", "export:export",
      "export-type:export-type", "import-equals:import-equals",
      "import-equals-type:import-equals-type", "type-query:type-query",
      "dynamic:dynamic", "commonjs:commonjs"], unresolved: [],
  });
});

const provenanceCases = [
  ["detached method", 'const load = module.require; load("edge");', [], ["commonjs"]],
  ["detached alias chain", 'const m = module; const first = m.require; const load = first; load("edge");', [], ["commonjs"]],
  ["detached projected method", 'const m = module; const { require: load } = m; load("edge");', [], ["commonjs"]],
  ["detached sequence method", '(0, module.require)("edge");', [], ["commonjs"]],
  ["detached logical method", '(module.require || user)("edge");', [], ["commonjs"]],
  ["detached conditional method", '(flag ? module.require : user)("edge");', [], ["commonjs"]],
  ["retained module alias", 'const m = module; m.require("edge");', ["commonjs:edge"], []],
  ["retained computed receiver", 'const m = module; (m["require"])("edge");', ["commonjs:edge"], []],
  ["retained optional receiver", 'const m = module; m?.require?.("edge");', ["commonjs:edge"], []],
  ["retained typed receiver", '(module.require as Function)("edge");', ["commonjs:edge"], []],
  ["ordinary require alias", 'const load = require; (0, load)("edge");', ["commonjs:edge"], []],
  ["detached builtin namespace stays opaque", 'const load = module.require; load("node:module").createRequire(import.meta.url)("edge");', [], ["commonjs", "commonjs"]],
  ["retained builtin namespace", 'module.require("node:module").createRequire(import.meta.url)("edge");', ["commonjs:node:module", "commonjs:edge"], []],
  ["user method alias", 'const module = { require() {} }; const load = module.require; load("edge");', [], []],
  ["written receiver", 'let m = module; m = user; m.require("edge");', [], ["commonjs"]],
  ["default parameter var", 'function f(load = require) { var load; load("edge"); } f();', [], ["commonjs"]],
  ["destructured default var", 'function f({load = require} = {}) { var load; load("edge"); } f();', [], ["commonjs"]],
  ["projected default var", 'function f({require: load} = module) { var load; load("edge"); } f();', [], ["commonjs"]],
  ["array default var", 'function f([load = require] = []) { var load; load("edge"); } f();', [], ["commonjs"]],
  ["nested destructured default var", 'function f({nested: {load = require} = {}} = {}) { var load; load("edge"); } f();', [], ["commonjs"]],
  ["arrow default var", 'const f = (load = require) => { var load; load("edge"); }; f();', [], ["commonjs"]],
  ["method default var", 'const object = { f(load = require) { var load; load("edge"); } };', [], ["commonjs"]],
  ["hoisted default var", 'function f(load = require) { load("edge"); { var load; } }', [], ["commonjs"]],
  ["default body initializer", 'function f(load = require) { var load = user; load("edge"); }', [], ["commonjs"]],
  ["default body reset", 'function f(load = require) { var load; load = user; load("edge"); }', [], ["commonjs"]],
  ["parameter write before body copy", 'function f(load, seed = (load = require)) { var load; load("edge"); }', [], ["commonjs"]],
  ["plain parameter redeclaration", 'const load = require; function f(load) { var load; load("edge"); }', [], []],
  ["plain function var shadows outer", 'const load = require; function f() { var load; load("edge"); }', [], []],
  ["user default var", 'function f(load = user) { var load; load("edge"); }', [], []],
  ["user destructured default var", 'function f({load = user} = {}) { var load; load("edge"); }', [], []],
  ["user array default var", 'function f([load = user] = []) { var load; load("edge"); }', [], []],
  ["unrelated body loader write", 'function f(load = user, probe = () => load("user")) { var load; load = require; load("edge"); }', [], ["commonjs"]],
  ["unrelated parameter closure", 'function f(load = user, probe = () => load("user")) { var load = require; }', [], []],
  ["parameter closure survives body reset", 'function f(load = require, probe = () => load("edge")) { var load = user; }', [], ["commonjs"]],
  ["body lexical shadow", 'function f(load = require) { { let load = user; load("user"); } var load; load("edge"); }', [], ["commonjs"]],
  ["body catch shadow", 'function f(load = require) { try {} catch (load) { load("user"); } var load; load("edge"); }', [], ["commonjs"]],
  ["nested function var shadow", 'function f(load = require) { var load; function g() { var load; load("user"); } load("edge"); }', [], ["commonjs"]],
  ["static block var shadow", 'function f(load = require) { var load; class C { static { var load; load("user"); } } load("edge"); }', [], ["commonjs"]],
  ["namespace var shadow", 'function f(load = require) { var load; namespace Local { var load; load("user"); } load("edge"); }', [], ["commonjs"]],
  ["parameter defaults exclude body require", 'function f(load = require) { var require; var load; load("edge"); require("user"); }', [], ["commonjs"]],
  ["copied default object shares member writes", 'import Module from "node:module"; function f(m = Module) { var m; m.createRequire = user; } Module.createRequire(import.meta.url)("edge");', ["static:node:module"], ["commonjs"]],
  ["copied default object reset stays local", 'import Module from "node:module"; function f(m = Module) { var m; m = user; } Module.createRequire(import.meta.url)("edge");', ["static:node:module", "commonjs:edge"], []],
];
for (const [name, source, references, unresolved] of provenanceCases) {
  test(`loader provenance: ${name}`, () => {
    assert.deepEqual(observe(source), { parseErrorCount: 0, references, unresolved });
  });
}

for (const extension of ["cjs", "cts"]) {
  for (const [name, source, references, unresolved] of [
    ["wrapper require var", 'var require; require("edge");', ["commonjs:edge"], []],
    ["wrapper module var", 'var module; module.require("edge");', ["commonjs:edge"], []],
    ["hoisted wrapper var", 'require("edge"); { var require; }', ["commonjs:edge"], []],
    ["wrapper require alias", 'var require; const load = require; load("edge");', ["commonjs:edge"], []],
    ["wrapper retained receiver", 'var module; const m = module; m.require("edge");', ["commonjs:edge"], []],
    ["wrapper detached method", 'var module; const load = module.require; load("edge");', [], ["commonjs"]],
    ["wrapper initializer", 'var require = user; require("edge");', [], ["commonjs"]],
    ["wrapper reset", 'var require; require = user; require("edge");', [], ["commonjs"]],
    ["wrapper module reset", 'var module; module = user; module.require("edge");', [], ["commonjs"]],
    ["wrapper member reset", 'var module; module.require = user; module.require("edge");', [], ["commonjs"]],
    ["wrapper iteration reset", 'for (var require of users) { require("edge"); }', [], ["commonjs"]],
    ["wrapper key iteration reset", 'for (var module in users) { module.require("edge"); }', [], ["commonjs"]],
    ["lexical iteration shadow", 'for (let require of users) { require("user"); }', [], []],
    ["lexical require shadow", '{ let require = user; require("user"); }', [], []],
    ["lexical module shadow", '{ const module = user; module.require("user"); }', [], []],
    ["function require var", 'function f() { var require; require("user"); }', [], []],
    ["function module var", 'function f() { var module; module.require("user"); }', [], []],
    ["function parameter", 'function f(require) { var require; require("user"); }', [], []],
    ["process is not a wrapper parameter", 'var process; process.getBuiltinModule("user");', [], []],
  ]) {
    test(`CommonJS ${extension}: ${name}`, () => {
      assert.deepEqual(observe(source, `case.${extension}`), { parseErrorCount: 0, references, unresolved });
    });
  }
}

for (const extension of ["js", "ts", "mjs", "mts", "d.ts", "d.cts", "d.mts"]) {
  test(`file context ${extension}: plain var declarations`, () => {
    const ambiguous = extension === "js" || extension === "ts";
    const declarations = 'var require; var module;';
    const calls = extension.startsWith("d.") ? "" : ' require("edge"); module.require("edge");';
    assert.deepEqual(observe(declarations + calls, `case.${extension}`), {
      parseErrorCount: 0, references: [], unresolved: ambiguous ? ["commonjs", "commonjs"] : [],
    });
  });
}
for (const extension of ["ts", "cts", "mts"]) {
  test(`file context ${extension}: explicit ambient values shadow`, () => {
    assert.deepEqual(observe('declare var require: any; declare var module: any; require("user"); module.require("user");', `case.${extension}`), {
      parseErrorCount: 0, references: [], unresolved: [],
    });
  });
}
for (const extension of ["js", "ts"]) {
  test(`file context ${extension}: ESM declarations and resets stay local`, () => {
    assert.deepEqual(observe('export {}; var require; var module; require = user; module = user; require("user"); module.require("user");', `case.${extension}`), {
      parseErrorCount: 0, references: [], unresolved: [],
    });
  });
}

for (const [name, header, references] of [
  ["type import", 'import type {T} from "types";', ["static-type:types"]],
  ["type export", 'export type T = string;', []],
  ["interface export", 'export interface T {}', []],
  ["ambient export", 'export declare const x: number;', []],
  ["default interface export", 'export default interface T {}', []],
  ["default function signature", 'export default function f(): void;', []],
  ["anonymous default function signature", 'export default function(): void;', []],
  ["type import equals", 'import type T = require("types");', ["import-equals-type:types"]],
]) {
  test(`erased ${name} cannot establish a runtime module mode`, () => {
    const source = `${header} var require; var module; require("edge"); module.require("edge");`;
    assert.deepEqual(observe(source, "case.ts"), {
      parseErrorCount: 0, references, unresolved: ["commonjs", "commonjs"],
    });
    assert.deepEqual(observe(source, "case.mts"), {
      parseErrorCount: 0, references, unresolved: [],
    });
    assert.deepEqual(observe(source, "case.cts"), {
      parseErrorCount: 0, references: [...references, "commonjs:edge", "commonjs:edge"], unresolved: [],
    });
  });
}
for (const [name, source, references, unresolved] of [
  ["runtime import", 'import {} from "runtime"; var require; require("user");', ["static:runtime"], []],
  ["inline type specifier retains runtime syntax", 'import {type T} from "types"; var require; require("user");', ["static-type:types"], []],
  ["import meta", 'import type {T} from "types"; import.meta.url; var require; require("user");', ["static-type:types"], []],
  ["top-level await", 'export type T = string; await user(); var require; require("user");', [], []],
  ["top-level await iteration", 'export type T = string; for await (const x of user) {} var require; require("user");', [], []],
  ["nested await leaves mode ambiguous", 'export type T = string; async function f() { await user(); } var require; require("edge");', [], ["commonjs"]],
  ["nested import meta establishes ESM", 'export type T = string; function f() { return import.meta.url; } var require; require("user");', [], []],
]) {
  test(`runtime module syntax: ${name}`, () => {
    assert.deepEqual(observe(source, "case.ts"), { parseErrorCount: 0, references, unresolved });
  });
}
