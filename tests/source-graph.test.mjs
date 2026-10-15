import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
