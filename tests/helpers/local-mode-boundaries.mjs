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

function stronglyConnectedComponents(edges) {
  const vertices = [...new Set(edges.flatMap(({ from, to }) => [from, to]))];
  function reachable(from, to, visited = new Set()) {
    if (from === to) {
      return true;
    }
    if (visited.has(from)) {
      return false;
    }
    visited.add(from);
    return edges.some((edge) => edge.from === from && reachable(edge.to, to, visited));
  }
  const assigned = new Set();
  const cycles = [];
  for (const vertex of vertices) {
    if (assigned.has(vertex)) {
      continue;
    }
    const component = vertices.filter((other) => reachable(vertex, other) && reachable(other, vertex));
    for (const member of component) {
      assigned.add(member);
    }
    if (component.length > 1) {
      cycles.push(component.toSorted());
    }
  }
  return cycles;
}

export async function observeFoundationFeatureGraph(root = repositoryRoot) {
  const base = join(root, "packages/engineering-foundation/src");
  const files = await sources(base);
  const known = new Set(files);
  const edges = [];
  const missing = [];
  for (const file of files) {
    const tree = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
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
