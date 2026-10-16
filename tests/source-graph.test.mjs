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
    { from: "src/a.ts", to: "src/b.ts", mode: "runtime", line: 1 },
    { from: "src/a.ts", to: "src/c.ts", mode: "type-only", line: 2 },
    { from: "src/b.ts", to: "src/a.ts", mode: "runtime", line: 1 },
    { from: "src/c.ts", to: "src/d.ts", mode: "type-only", line: 1 },
    { from: "src/d.ts", to: "src/c.ts", mode: "type-only", line: 1 }
  ]);
  assert.deepEqual(graph.unresolved, [{ from: "src/a.ts", specifier: "../outside.js", line: 4 }]);
  assert.deepEqual(graph.external, [{ from: "src/a.ts", specifier: "node:fs", line: 3 }]);
  assert.deepEqual(graph.parseFailures, []);
  assert.deepEqual(stronglyConnectedComponents(graph.edges), [["src/a.ts", "src/b.ts"], ["src/c.ts", "src/d.ts"]]);
  assert.deepEqual(stronglyConnectedComponents(graph.edges.filter(({ mode }) => mode === "runtime")), [["src/a.ts", "src/b.ts"]]);
});

test("a file that does not parse is reported and contributes no edges", async (t) => {
  const consumerRoot = await tree(t, { "src/bad.ts": 'import { x } from "./ok.js";\nexport const = ;\n', "src/ok.ts": "export const x = 1;\n" });
  const graph = await observeSourceGraph({ consumerRoot, roots: ["src"] });
  assert.deepEqual(graph.parseFailures, ["src/bad.ts"]);
  assert.deepEqual(graph.edges, []);
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
  assert.deepEqual(graph.edges, [{ from: "tests/a.test.ts", to: "src/a.ts", mode: "runtime", line: 1 }]);
  assert.deepEqual(graph.unresolved, [{ from: "tests/a.test.ts", specifier: "../dist/index.js", line: 2 }]);
  assert.deepEqual(graph.external, []);
});
