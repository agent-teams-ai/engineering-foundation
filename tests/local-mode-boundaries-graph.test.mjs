import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { observeFoundationFeatureGraph, stronglyConnectedComponents } from "./helpers/local-mode-boundaries.mjs";

const edgesOf = (pairs) => pairs.map(([from, to]) => ({ from, to }));

// Duplicate edges do not create a cycle; singleton self-loops retain the old meaning.
test("SCC oracle omits empty graphs, duplicate DAG edges and singleton self-loops", () => {
  assert.deepEqual(stronglyConnectedComponents([]), []);
  assert.deepEqual(stronglyConnectedComponents(edgesOf([
    ["start", "middle"], ["start", "middle"], ["middle", "end"],
    ["start", "end"], ["end", "end"], ["alone", "alone"]
  ])), []);
});

// Sink-first DFS completion must not reorder components or merge one-way links.
test("SCC oracle keeps separate components in first-endpoint order with sorted members", () => {
  const edges = edgesOf([
    ["z", "y"], ["y", "z"], ["z", "a"],
    ["a", "b"], ["b", "a"], ["c", "a"], ["c", "c"],
    ["w", "x"], ["x", "w"], ["x", "a"], ["a", "b"]
  ]);
  const before = structuredClone(edges);
  assert.deepEqual(stronglyConnectedComponents(edges), [["y", "z"], ["a", "b"], ["w", "x"]]);
  assert.deepEqual(stronglyConnectedComponents(edges.toReversed()), [["a", "b"], ["w", "x"], ["y", "z"]]);
  assert.deepEqual(edges, before);
});

// An already visited sibling can still be active in the same component.
test("SCC oracle includes a branch pointing back into an active sibling", () => {
  assert.deepEqual(stronglyConnectedComponents(edgesOf([
    ["a", "b"], ["b", "a"], ["a", "c"], ["c", "b"]
  ])), [["a", "b", "c"]]);
});

// Boolean transitive closure independently checks every finite three-vertex graph.
test("SCC oracle matches independent reachability for all three-vertex directed graphs", () => {
  const names = ["z", "a", "m"];
  for (let mask = 0; mask < 512; mask += 1) {
    const edges = [];
    const reachable = names.map((_, from) => names.map((__, to) => from === to));
    for (let from = 0; from < 3; from += 1) {
      for (let to = 0; to < 3; to += 1) {
        if (mask & (1 << (from * 3 + to))) {
          edges.push({ from: names[from], to: names[to] });
          reachable[from][to] = true;
        }
      }
    }
    for (let via = 0; via < 3; via += 1) {
      for (let from = 0; from < 3; from += 1) {
        for (let to = 0; to < 3; to += 1) {
          reachable[from][to] ||= reachable[from][via] && reachable[via][to];
        }
      }
    }
    const vertices = [...new Set(edges.flatMap(({ from, to }) => [from, to]))];
    const assigned = new Set();
    const expected = [];
    for (const vertex of vertices) {
      if (assigned.has(vertex)) { continue; }
      const from = names.indexOf(vertex);
      const members = vertices.filter((other) => {
        const to = names.indexOf(other);
        return reachable[from][to] && reachable[to][from];
      });
      for (const member of members) { assigned.add(member); }
      if (members.length > 1) { expected.push(members.toSorted()); }
    }
    assert.deepEqual(stronglyConnectedComponents(edges), expected, `graph mask ${mask}`);
  }
});

// Recursive DFS overflows on this depth even though the graph has no cycles.
test("SCC oracle traverses a deep DAG without using the JavaScript call stack", () => {
  const edges = Array.from({ length: 24_999 }, (_, index) => ({ from: `v${index}`, to: `v${index + 1}` }));
  assert.deepEqual(stronglyConnectedComponents(edges), []);
});

// Every member of a deep cycle must survive traversal and normalization.
test("SCC oracle reports every member of a deep cycle without stack overflow", () => {
  const members = Array.from({ length: 25_000 }, (_, index) => `v${index}`);
  const edges = members.map((from, index) => ({ from, to: members[(index + 1) % members.length] }));
  assert.deepEqual(stronglyConnectedComponents(edges), [members.toSorted()]);
});

async function writeSource(root, path, source) {
  const file = join(root, "packages/engineering-foundation/src", path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source);
}

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), "ef-g-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(files)) { await writeSource(root, path, source); }
  return root;
}

function observedEdge(from, to, file, target, specifier, typeOnly = false) {
  return { from, to, file: join(...file.split("/")), target: join(...target.split("/")), specifier, typeOnly };
}

const normalizedEdges = (edges) => edges.toSorted((left, right) =>
  JSON.stringify(left).localeCompare(JSON.stringify(right)));

// Settled parallel reads must surface the actual I/O failure, never a partial graph.
test("feature observer rejects unreadable source before accepting a partial inventory", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (t) => {
  const root = await fixture(t, {
    "features/a/entry.ts": "export const a = 1;",
    "features/b/entry.ts": "export const b = 2;",
  });
  const unreadable = join(root, "packages/engineering-foundation/src/features/b/entry.ts");
  await chmod(unreadable, 0o000);
  try {
    await assert.rejects(observeFoundationFeatureGraph(root), { code: "EACCES" });
  } finally {
    await chmod(unreadable, 0o600);
  }
});

// A late read error must not replace the earlier syntax diagnostic after prefetch.
test("feature observer retains the first inventory-ordered syntax or read failure", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (t) => {
  const root = await fixture(t, {
    "features/a/entry.ts": "export const = ;",
    "features/z/entry.ts": "export const z = 1;",
  });
  const unreadable = join(root, "packages/engineering-foundation/src/features/z/entry.ts");
  await chmod(unreadable, 0o000);
  try {
    await assert.rejects(observeFoundationFeatureGraph(root), {
      code: "ERR_ASSERTION",
      message: /features[/\\]a[/\\]entry\.ts/u,
    });
  } finally {
    await chmod(unreadable, 0o600);
  }
});

// Actual TS parsing must distinguish value edges from all supported type forms,
// while counting glue sources and retaining lifecycle/reporting feature ownership.
test("feature observer preserves the full fixture inventory and separate runtime and type graphs", async (t) => {
  const files = {
    "index.ts": 'export { alpha } from "./features/alpha/entry.js";',
    "composition/main.ts": 'export { beta } from "../features/beta/entry.js";',
    "features/alpha/entry.ts": [
      'import { beta } from "../beta/entry.js";',
      'export type { Gamma } from "../gamma/entry.js";',
      "export const alpha = beta;"
    ].join("\n"),
    "features/alpha/types.ts": "export interface Alpha { value: number }",
    "features/beta/entry.ts": 'export { alpha } from "../alpha/entry.js"; export const beta = 1;',
    "features/gamma/entry.ts": 'import type { Alpha } from "../alpha/types.js"; export type Gamma = Alpha;',
    "local-mode/attach.ts": 'export { alpha } from "../features/alpha/entry.js";',
    "package-self-check.ts": 'export { alpha } from "./local-mode/attach.js";',
    "capability-runtime.ts": 'export { report } from "./features/validation-reporting/report.js";',
    "features/validation-reporting/report.ts": 'export const report = true; export { type Gamma } from "../gamma/entry.js";',
    "capabilities/delta/check.ts": [
      'import { type Alpha } from "../../features/alpha/types.js";',
      'export type G = import("../../features/gamma/entry.js").Gamma;',
      'export const load = () => import("../../features/beta/entry.js");'
    ].join("\n")
  };
  const graph = await observeFoundationFeatureGraph(await fixture(t, files));
  assert.equal(graph.files, Object.keys(files).length);
  assert.deepEqual(graph.missing, []);
  assert.deepEqual(graph.runtimeCycles, [["alpha", "beta"]]);
  assert.deepEqual(graph.combinedCycles, [["alpha", "beta", "gamma"]]);
  assert.deepEqual(normalizedEdges(graph.edges), normalizedEdges([
    observedEdge("alpha", "beta", "features/alpha/entry.ts", "features/beta/entry.ts", "../beta/entry.js"),
    observedEdge("alpha", "gamma", "features/alpha/entry.ts", "features/gamma/entry.ts", "../gamma/entry.js", true),
    observedEdge("beta", "alpha", "features/beta/entry.ts", "features/alpha/entry.ts", "../alpha/entry.js"),
    observedEdge("gamma", "alpha", "features/gamma/entry.ts", "features/alpha/types.ts", "../alpha/types.js", true),
    observedEdge("local-package-lifecycle", "alpha", "local-mode/attach.ts", "features/alpha/entry.ts", "../features/alpha/entry.js"),
    observedEdge("validation-reporting", "gamma", "features/validation-reporting/report.ts", "features/gamma/entry.ts", "../gamma/entry.js", true),
    observedEdge("delta", "alpha", "capabilities/delta/check.ts", "features/alpha/types.ts", "../../features/alpha/types.js", true),
    observedEdge("delta", "gamma", "capabilities/delta/check.ts", "features/gamma/entry.ts", "../../features/gamma/entry.js", true),
    observedEdge("delta", "beta", "capabilities/delta/check.ts", "features/beta/entry.ts", "../../features/beta/entry.js")
  ]));
});

// A repeated observation must see changed edges, missing targets and source inventory.
test("feature observer sees missing imports and cycles after source mutation and removal", async (t) => {
  const original = "export const b = 2;";
  const root = await fixture(t, {
    "features/a/entry.ts": 'export { b } from "../b/entry.js"; export const a = 1;',
    "features/b/entry.ts": original
  });
  const before = await observeFoundationFeatureGraph(root);
  assert.deepEqual(before, {
    files: 2, missing: [],
    edges: [observedEdge("a", "b", "features/a/entry.ts", "features/b/entry.ts", "../b/entry.js")],
    runtimeCycles: [], combinedCycles: []
  });
  await writeSource(root, "features/b/entry.ts", [
    original, 'export { a } from "../a/entry.js";', 'export { gone } from "../missing/entry.js";'
  ].join("\n"));
  await writeSource(root, "features/c/entry.ts", 'export type { a } from "../a/entry.js";');
  const after = await observeFoundationFeatureGraph(root);
  assert.equal(after.files, 3);
  assert.deepEqual(after.missing, [{
    file: join("features", "b", "entry.ts"), specifier: "../missing/entry.js", typeOnly: false
  }]);
  assert.deepEqual(after.runtimeCycles, [["a", "b"]]);
  assert.deepEqual(after.combinedCycles, [["a", "b"]]);
  assert.deepEqual(normalizedEdges(after.edges), normalizedEdges([
    ...before.edges,
    observedEdge("b", "a", "features/b/entry.ts", "features/a/entry.ts", "../a/entry.js"),
    observedEdge("b", "missing", "features/b/entry.ts", "features/missing/entry.ts", "../missing/entry.js"),
    observedEdge("c", "a", "features/c/entry.ts", "features/a/entry.ts", "../a/entry.js", true)
  ]));
  await writeSource(root, "features/b/entry.ts", original);
  await rm(join(root, "packages/engineering-foundation/src/features/c/entry.ts"));
  assert.deepEqual(await observeFoundationFeatureGraph(root), before);
});
