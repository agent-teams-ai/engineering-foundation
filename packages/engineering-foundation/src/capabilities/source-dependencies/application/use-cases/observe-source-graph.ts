import type { SourceTreeReader } from "../../../../source-inventory/api.js";
import type { WorkspacePackage } from "../../../../workspace-inventory/api.js";
import type { ArchitectureBoundaryPolicy, ClassifiedSourceFile } from "../model/source-workspace.js";
import { normalizeRepositoryPath } from "../model/repository-path.js";
import { stronglyConnectedComponents as components } from "../policies/evaluate-source-dependency-cycles.js";
import type { SourceDependencyParser } from "../ports/source-dependency-parser.js";
import type { SourceDependencyResolver } from "../ports/source-dependency-resolver.js";
import { buildObservedSourceGraph } from "./build-observed-source-graph.js";

export interface SourceGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly mode: "runtime" | "type-only";
  /** One-based line of the import. */
  readonly line: number;
}

export interface SourceGraphUnresolved {
  readonly from: string;
  readonly specifier: string;
  readonly line: number;
}

export interface SourceGraph {
  /** Repository-relative files under the requested roots, in binary order. */
  readonly files: readonly string[];
  /** Resolved imports between those files, one per import, in binary order. */
  readonly edges: readonly SourceGraphEdge[];
  /** Relative or aliased imports that did not resolve to a file in `files`. */
  readonly unresolved: readonly SourceGraphUnresolved[];
  /** Files the parser could not read. Their imports are absent from `edges`. */
  readonly parseFailures: readonly string[];
}

export interface ObserveSourceGraphInput {
  readonly consumerRoot: string;
  /** Repository-relative roots to observe. */
  readonly roots: readonly string[];
  readonly signal?: AbortSignal;
}

// The graph is architecture-neutral: one synthetic boundary and package own every file.
const boundary: ArchitectureBoundaryPolicy = Object.freeze({
  id: "source-graph", dependencyMode: "runtime", roots: [], entrypoints: [], packageExports: [],
  allowedBoundaries: [], allowedPackages: [], allowedBuiltins: [], allowedRuntimeReferences: []
});
const workspacePackage: WorkspacePackage = Object.freeze({
  name: "source-graph", rootPath: ".", manifestPath: "package.json", moduleType: "module",
  dependencies: [], bundledDependencies: [], exportSurface: { explicit: false, entries: [] }
});

// UTF-16 code unit order, the order of compareBinaryStrings; only the consumers admitted by ADR-0047 may import that primitive.
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = source.indexOf("\n"); index !== -1 && index < offset; index = source.indexOf("\n", index + 1)) { line += 1; }
  return line;
}

export interface SourceGraphDependencies {
  readonly parser: SourceDependencyParser;
  readonly resolver: SourceDependencyResolver;
  readonly sourceReader: SourceTreeReader;
}

/** Reads the files under `roots` and resolves their imports with the parser and resolver of `architecture.source-dependencies`. */
export async function observeSourceGraph(input: ObserveSourceGraphInput, dependencies: SourceGraphDependencies): Promise<SourceGraph> {
  const files = await dependencies.sourceReader.read(input.consumerRoot, input.roots, input.signal);
  const { parser } = dependencies;
  const sources = new Map(files.map((file) => [normalizeRepositoryPath(file.path), file.source]));
  const classifiedFiles: ClassifiedSourceFile[] = files.map((file) => ({
    ...file, path: normalizeRepositoryPath(file.path), boundary, workspacePackage, parsed: parser.parse(file)
  }));
  const graph = buildObservedSourceGraph({
    consumerRoot: input.consumerRoot,
    inventory: { catalogs: [], packages: [workspacePackage] },
    allSourceFiles: files,
    classifiedFiles,
    resolver: dependencies.resolver,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const line = (path: string, offset: number) => lineAt(sources.get(path) ?? "", offset);
  const edges: SourceGraphEdge[] = [];
  const unresolved: SourceGraphUnresolved[] = [];
  for (const edge of graph.edges) {
    if (edge.resolution.kind === "local-file") {
      edges.push({ from: edge.fromPath, to: edge.resolution.path, mode: edge.mode, line: line(edge.fromPath, edge.start) });
    } else if (edge.resolution.kind === "unresolved" || edge.resolution.kind === "unsupported") {
      unresolved.push({ from: edge.fromPath, specifier: edge.specifier, line: line(edge.fromPath, edge.start) });
    }
  }
  return Object.freeze({
    files: Object.freeze(graph.nodes.map(({ path }) => path).toSorted(compareText)),
    edges: Object.freeze(edges.toSorted((left, right) => compareText(left.from, right.from) || compareText(left.to, right.to) || left.line - right.line)),
    unresolved: Object.freeze(unresolved),
    parseFailures: Object.freeze(graph.parseFailures.map(({ path }) => path))
  });
}

/** Strongly connected components of any edge set. Only components with more than one node are returned. */
export function stronglyConnectedComponents(edges: readonly Pick<SourceGraphEdge, "from" | "to">[]): readonly (readonly string[])[] {
  const adjacency = new Map<string, { readonly to: string }[]>();
  for (const { from, to } of edges) {
    const outgoing = adjacency.get(from) ?? [];
    outgoing.push({ to });
    adjacency.set(from, outgoing);
    if (!adjacency.has(to)) { adjacency.set(to, []); }
  }
  return components(adjacency);
}
