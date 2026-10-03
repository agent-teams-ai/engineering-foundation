import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const ts = createRequire(new URL("../../spikes/source-dependency-parser/package.json", import.meta.url))("typescript");

export async function copySourcePolicyFixture(destination) {
  for (const path of ["packages", "spikes", "architecture", "foundation.config.yaml", "pnpm-workspace.yaml", "package.json"]) {
    await cp(join(repositoryRoot, path), join(destination, path), {
      recursive: true,
      filter: (source) => !["node_modules", "dist"].includes(source.split(/[\\/]/).at(-1))
    });
  }
}

export function actualSourceDependenciesCLI(consumerRoot) {
  const result = spawnSync(process.execPath, [
    join(repositoryRoot, "packages/engineering-foundation/dist/cli.js"),
    "check", "architecture.source-dependencies", "--consumer", consumerRoot, "--json"
  ], { encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return { exitCode: result.status, report: JSON.parse(result.stdout), stderr: result.stderr };
}

function feature(path) {
  if (path.startsWith("local-mode/") || path === "package-self-check.ts") {
    return "local-package-lifecycle";
  }
  if (path.startsWith("features/validation-reporting/") ||
      ["unexpected-failure.ts", "capability-runtime.ts", "check-contract.ts", "unique-registry.ts"].includes(path)) {
    return "validation-reporting";
  }
  if (["index.ts", "public-api-surface.ts", "cli.ts"].includes(path) || path.startsWith("composition/")) {
    return;
  }
  if (path.startsWith("features/") || path.startsWith("capabilities/")) {
    return path.split("/")[1];
  }
  return path.split("/")[0];
}

async function sources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sources(path));
    } else if (path.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function references(tree) {
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings ?? node.exportClause;
      const typeOnly = !!(node.isTypeOnly || clause?.isTypeOnly ||
        (!clause?.name && bindings?.elements?.length && bindings.elements.every((item) => item.isTypeOnly)));
      imports.push({ specifier: node.moduleSpecifier.text, typeOnly });
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      imports.push({ specifier: node.arguments[0].text, typeOnly: false });
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      imports.push({ specifier: node.argument.literal.text, typeOnly: true });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return imports;
}

export function stronglyConnectedComponents(edges) {
  // Iterative Tarjan keeps this test oracle independent of production Kosaraju.
  const adjacency = new Map();
  for (const { from, to } of edges) {
    if (!adjacency.has(from)) { adjacency.set(from, []); }
    if (!adjacency.has(to)) { adjacency.set(to, []); }
    adjacency.get(from).push(to);
  }
  const indices = new Map();
  const lowLinks = new Map();
  const active = [];
  const onStack = new Set();
  const componentByMember = new Map();
  let nextIndex = 0;

  function enter(vertex) {
    indices.set(vertex, nextIndex);
    lowLinks.set(vertex, nextIndex);
    nextIndex += 1;
    active.push(vertex);
    onStack.add(vertex);
    return { vertex, next: 0 };
  }

  for (const vertex of adjacency.keys()) {
    if (indices.has(vertex)) { continue; }
    const frames = [enter(vertex)];
    while (frames.length > 0) {
      const frame = frames.at(-1);
      const targets = adjacency.get(frame.vertex);
      if (frame.next < targets.length) {
        const target = targets[frame.next];
        frame.next += 1;
        if (!indices.has(target)) {
          frames.push(enter(target));
        } else if (onStack.has(target)) {
          lowLinks.set(frame.vertex, Math.min(lowLinks.get(frame.vertex), indices.get(target)));
        }
        continue;
      }

      frames.pop();
      if (lowLinks.get(frame.vertex) === indices.get(frame.vertex)) {
        const component = [];
        let member;
        do {
          member = active.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.vertex);
        // A single self-loop remains outside the oracle's nontrivial cycles.
        if (component.length > 1) {
          const normalized = component.toSorted();
          for (const item of component) { componentByMember.set(item, normalized); }
        }
      }
      if (frames.length > 0) {
        const parent = frames.at(-1).vertex;
        lowLinks.set(parent, Math.min(lowLinks.get(parent), lowLinks.get(frame.vertex)));
      }
    }
  }

  // Tarjan finishes sinks first; retain the old first-observed-vertex order.
  const cycles = [];
  const emitted = new Set();
  for (const vertex of adjacency.keys()) {
    const component = componentByMember.get(vertex);
    if (component && !emitted.has(component)) {
      emitted.add(component);
      cycles.push(component);
    }
  }
  return cycles;
}

export async function observeFoundationFeatureGraph(root = repositoryRoot) {
  const base = join(root, "packages/engineering-foundation/src");
  const files = await sources(base);
  const known = new Set(files);
  const contents = new Array(files.length);
  let nextFile = 0;
  // Read every source afresh, with bounded I/O; parse in inventory order below.
  const readers = Array.from({ length: Math.min(8, files.length) }, async () => {
    while (nextFile < files.length) {
      const index = nextFile++;
      try {
        contents[index] = { source: await readFile(files[index], "utf8") };
      } catch (error) {
        contents[index] = { error };
      }
    }
  });
  // Drain all reads before surfacing a failure, so fixture cleanup cannot race them.
  for (const result of await Promise.allSettled(readers)) {
    if (result.status === "rejected") { throw result.reason; }
  }
  const edges = [];
  const missing = [];
  for (const [index, file] of files.entries()) {
    // Keep the first inventory-ordered read or syntax failure, not completion order.
    if (Object.hasOwn(contents[index], "error")) { throw contents[index].error; }
    const tree = ts.createSourceFile(file, contents[index].source, ts.ScriptTarget.Latest, true);
    assert.equal(tree.parseDiagnostics.length, 0, file);
    for (const reference of references(tree)) {
      if (!reference.specifier.startsWith(".")) {
        continue;
      }
      const target = resolve(dirname(file), reference.specifier.replace(/\.js$/, ".ts"));
      if (!known.has(target)) {
        missing.push({ file: relative(base, file), ...reference });
      }
      const from = feature(relative(base, file));
      const to = feature(relative(base, target));
      if (from && to && from !== to) {
        edges.push({ from, to, file: relative(base, file), target: relative(base, target), ...reference });
      }
    }
  }
  return {
    files: files.length, missing, edges,
    runtimeCycles: stronglyConnectedComponents(edges.filter((edge) => !edge.typeOnly)),
    combinedCycles: stronglyConnectedComponents(edges)
  };
}
