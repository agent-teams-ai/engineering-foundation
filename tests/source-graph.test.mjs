import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { observeSourceGraph, stronglyConnectedComponents } from "../packages/engineering-foundation/dist/source-graph.js";

async function tree(t, files) {
  const root = await mkdtemp(join(tmpdir(), "source graph "));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
  return root;
}

test("source graph returns runtime and type-only edges with lines, unresolved imports and cycles", async (t) => {
  const consumerRoot = await tree(t, {
    "src/a.ts": 'import { b } from "./b.js";\nimport type { C } from "./c.js";\nimport { fs } from "node:fs";\nimport "../outside.js";\nexport const a = b;\n',
    "src/b.ts": 'import { a } from "./a.js";\nexport const b = 1;\nexport type B = typeof a;\n',
    "src/c.ts": 'import type { C as D } from "./d.js";\nexport type C = D;\n',
    "src/d.ts": 'import type { C } from "./c.js";\nexport type D = C;\n',
    "src/e.ts": "export const e = 1;\n"
  });
  const graph = await observeSourceGraph({ consumerRoot, roots: ["src"] });
  assert.deepEqual(graph.files, ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]);
  assert.deepEqual(graph.edges, [
    { from: "src/a.ts", to: "src/b.ts", kind: "static", mode: "runtime", line: 1 },
    { from: "src/a.ts", to: "src/c.ts", kind: "static-type", mode: "type-only", line: 2 },
    { from: "src/b.ts", to: "src/a.ts", kind: "static", mode: "runtime", line: 1 },
    { from: "src/c.ts", to: "src/d.ts", kind: "static-type", mode: "type-only", line: 1 },
    { from: "src/d.ts", to: "src/c.ts", kind: "static-type", mode: "type-only", line: 1 }
  ]);
  assert.deepEqual(graph.unresolved, [{ from: "src/a.ts", specifier: "../outside.js", kind: "static", mode: "runtime", line: 4 }]);
  assert.deepEqual(graph.external, [{ from: "src/a.ts", specifier: "node:fs", kind: "static", mode: "runtime", line: 3 }]);
  assert.deepEqual(graph.unresolvedRuntimeReferences, []);
  assert.deepEqual(graph.parseFailures, []);
  assert.deepEqual(stronglyConnectedComponents(graph.edges), [["src/a.ts", "src/b.ts"], ["src/c.ts", "src/d.ts"]]);
  assert.deepEqual(stronglyConnectedComponents(graph.edges.filter(({ mode }) => mode === "runtime")), [["src/a.ts", "src/b.ts"]]);
});

test("a file that does not parse is reported and contributes no edges", async (t) => {
  const consumerRoot = await tree(t, { "src/bad.ts": 'import { x } from "./ok.js";\nexport const = ;\n', "src/ok.ts": "export const x = 1;\n" });
  const graph = await observeSourceGraph({ consumerRoot, roots: ["src"] });
  assert.deepEqual(graph.parseFailures, ["src/bad.ts"]);
  assert.deepEqual(graph.edges, []);
  assert.deepEqual(graph.runtimeExports.find(({ path }) => path === "src/bad.ts"), {
    path: "src/bad.ts", status: "parse-failure", exports: [], unsupported: []
  });
});

test("the Foundation source tree gives real-data parity: it parses completely and has no runtime import cycle", async () => {
  const consumerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const graph = await observeSourceGraph({ consumerRoot, roots: ["packages/engineering-foundation/src"] });
  assert.deepEqual(graph.parseFailures, []);
  assert.ok(graph.files.length > 300 && graph.edges.length > 1000);
  assert.deepEqual(stronglyConnectedComponents(graph.edges.filter(({ mode }) => mode === "runtime")), []);
});

test("bare specifiers are reported as external in a stable order and never become edges", async (t) => {
  const consumerRoot = await tree(t, {
    "src/z.ts": 'import "zod";\nimport { x } from "@scope/pkg/sub";\nimport { y } from "@/alias";\nexport const z = 1;\n',
    "src/a.ts": 'import { p } from "pkg";\nimport { q } from "node:path";\nexport const a = 1;\n'
  });
  const graph = await observeSourceGraph({ consumerRoot, roots: ["src"] });
  assert.deepEqual(graph.edges, []);
  assert.deepEqual(graph.external.map(({ from, line, specifier }) => `${from}:${line} ${specifier}`),
    ["src/a.ts:1 pkg", "src/a.ts:2 node:path", "src/z.ts:1 zod", "src/z.ts:2 @scope/pkg/sub", "src/z.ts:3 @/alias"]);
});

test("an import of build output is reported as unresolved, not dropped", async (t) => {
  const consumerRoot = await tree(t, {
    "package.json": '{"name":"app","type":"module"}\n',
    "src/a.ts": "export const a = 1;\n",
    "dist/index.js": "export const b = 1;\n",
    "tests/a.test.ts": 'import { a } from "../src/a.js";\nimport { b } from "../dist/index.js";\nexport const t = [a, b];\n'
  });
  const graph = await observeSourceGraph({ consumerRoot, roots: ["src", "tests"] });
  assert.deepEqual(graph.edges, [{ from: "tests/a.test.ts", to: "src/a.ts", kind: "static", mode: "runtime", line: 1 }]);
  assert.deepEqual(graph.unresolved, [{ from: "tests/a.test.ts", specifier: "../dist/index.js", kind: "static", mode: "runtime", line: 2 }]);
  assert.deepEqual(graph.external, []);
});

test("runtime export facts observe a real extra export without counting erased TypeScript declarations", async (t) => {
  const source = 'export async function runJob() { return "ok"; }\nexport interface Request {}\nexport type Result = string;\nexport declare const ambient: string;\n';
  const consumerRoot = await tree(t, { "src/run-job.ts": source });
  const before = await observeSourceGraph({ consumerRoot, roots: ["src"] });
  assert.deepEqual(before.runtimeExports, [{
    path: "src/run-job.ts", status: "complete", exports: [{ name: "runJob", kind: "function", line: 1 }], unsupported: []
  }]);
  await writeFile(join(consumerRoot, "src/run-job.ts"), `${source}export const extra = 1;\n`);
  const after = await observeSourceGraph({ consumerRoot, roots: ["src"] });
  assert.deepEqual(after.runtimeExports, [{
    path: "src/run-job.ts", status: "complete", exports: [
      { name: "runJob", kind: "function", line: 1 }, { name: "extra", kind: "value", line: 5 }
    ], unsupported: []
  }]);
  assert.ok(Object.isFrozen(after.runtimeExports[0].exports[0]));
});

test("direct function expressions and non-function values retain their observed names and kinds", async (t) => {
  const consumerRoot = await tree(t, {
    "src/direct.ts": 'export const arrow = (() => 1) satisfies (() => number), fn = function () {};\nexport const value = { x: 1 };\nexport default async function () {}\n'
  });
  const graph = await observeSourceGraph({ consumerRoot, roots: ["src"] });
  assert.deepEqual(graph.runtimeExports, [{
    path: "src/direct.ts", status: "complete", exports: [
      { name: "arrow", kind: "function", line: 1 }, { name: "fn", kind: "function", line: 1 },
      { name: "value", kind: "value", line: 2 }, { name: "default", kind: "function", line: 3 }
    ], unsupported: []
  }]);
});

test("unknown export values and republication never establish a complete export count", async (t) => {
  const consumerRoot = await tree(t, {
    "src/alias.ts": 'import { run } from "./run.js";\nexport { run };\n',
    "src/factory.ts": 'declare function factory(): unknown;\nexport const run = factory();\n',
    "src/local-alias.ts": 'const run = () => 1;\nexport { run };\n',
    "src/mutable.ts": 'export let run = () => 1;\n',
    "src/reexport.ts": 'export { run } from "./run.js";\nexport * from "./run.js";\n',
    "src/run.ts": 'export function run() {}\n',
    "src/script.cjs": 'module.exports = { run() {} };\n'
  });
  const graph = await observeSourceGraph({ consumerRoot, roots: ["src"] });
  const facts = Object.fromEntries(graph.runtimeExports.map((entry) => [entry.path, entry]));
  for (const path of ["src/alias.ts", "src/factory.ts", "src/local-alias.ts", "src/mutable.ts", "src/reexport.ts", "src/script.cjs"]) {
    assert.equal(facts[path].status, "unsupported", path);
    assert.ok(facts[path].unsupported.length > 0, path);
  }
  assert.deepEqual(facts["src/alias.ts"].unsupported, [{ kind: "reexport", line: 2 }]);
  assert.deepEqual(facts["src/local-alias.ts"].unsupported, [{ kind: "binding", line: 2 }]);
  assert.deepEqual(facts["src/reexport.ts"].unsupported, [{ kind: "reexport", line: 1 }, { kind: "reexport", line: 2 }]);
  assert.deepEqual(graph.edges.map(({ from, to, kind }) => ({ from, to, kind })), [
    { from: "src/alias.ts", to: "src/run.ts", kind: "static" },
    { from: "src/reexport.ts", to: "src/run.ts", kind: "export" },
    { from: "src/reexport.ts", to: "src/run.ts", kind: "export" }
  ]);
});

test("literal loader kinds and unresolved computed loaders both survive the public graph projection", async (t) => {
  const consumerRoot = await tree(t, {
    "src/target.ts": 'export const value = 1;\n',
    "src/load.ts": 'const target = "./target.js";\nvoid import(target);\nconst load = require;\nload(target);\nvoid import("./target.js");\nload("./target.js");\nexport {};\n'
  });
  const graph = await observeSourceGraph({ consumerRoot, roots: ["src"] });
  assert.deepEqual(graph.unresolvedRuntimeReferences, [
    { from: "src/load.ts", kind: "dynamic", line: 2 }, { from: "src/load.ts", kind: "commonjs", line: 4 }
  ]);
  assert.deepEqual(graph.edges, [
    { from: "src/load.ts", to: "src/target.ts", kind: "dynamic", mode: "runtime", line: 5 },
    { from: "src/load.ts", to: "src/target.ts", kind: "commonjs", mode: "runtime", line: 6 }
  ]);
});
