import type { SourceTreeReader } from "../../../../source-inventory/api.js";
import type { WorkspacePackage } from "../../../../workspace-inventory/api.js";
import type {
  ArchitectureBoundaryPolicy, ClassifiedSourceFile, SourceDependencyKind,
  SourceRuntimeExportKind, UnresolvedSourceDependency, UnsupportedSourceExport
} from "../model/source-workspace.js";
import { normalizeRepositoryPath } from "../model/repository-path.js";
import { stronglyConnectedComponents as components } from "../policies/evaluate-source-dependency-cycles.js";
import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import type { SourceDependencyParser } from "../ports/source-dependency-parser.js";
import type { SourceDependencyResolver } from "../ports/source-dependency-resolver.js";
import { buildObservedSourceGraph } from "./build-observed-source-graph.js";

export type SourceGraphReferenceKind = SourceDependencyKind;

export interface SourceGraphEdge {
  readonly from: string;
  readonly to: string;
  /** Observed syntax, not a claim that every runtime reference executes at load time. */
  readonly kind: SourceGraphReferenceKind;
  readonly mode: "runtime" | "type-only";
  /** One-based line of the import. */
  readonly line: number;
}

export interface SourceGraphUnresolved {
  readonly from: string;
  readonly specifier: string;
  readonly kind: SourceGraphReferenceKind;
  readonly mode: "runtime" | "type-only";
  readonly line: number;
}

/** An import of a bare specifier: a Node.js builtin, a package, a workspace package or a tsconfig paths alias. */
export type SourceGraphExternal = SourceGraphUnresolved;

export interface SourceGraphRuntimeReference {
  readonly from: string;
  readonly kind: UnresolvedSourceDependency["kind"];
  readonly line: number;
}

export interface SourceGraphExport {
  readonly name: string;
  /** Direct function syntax or another direct value (including classes); expressions are not executed. */
  readonly kind: SourceRuntimeExportKind;
  readonly line: number;
}

export interface SourceGraphUnsupportedExport {
  readonly kind: UnsupportedSourceExport["kind"];
  readonly line: number;
}

export interface SourceGraphFileExports {
  readonly path: string;
  readonly status: "complete" | "unsupported" | "parse-failure";
  /** A complete count only when status is complete. Type-only and explicit declare exports are erased. */
  readonly exports: readonly SourceGraphExport[];
  readonly unsupported: readonly SourceGraphUnsupportedExport[];
}

export interface SourceGraph {
  /** Repository-relative files under the requested roots, in binary order. */
  readonly files: readonly string[];
  /** Resolved imports between those files, one per import, in binary order. */
  readonly edges: readonly SourceGraphEdge[];
  /**
   * Imports that are neither an edge nor a bare specifier: relative imports that did not resolve to a file in `files`
   * (including build output such as `../dist/index.js`) and specifiers the resolver does not support (subpath imports, URLs).
   * Non-literal loaders are retained separately in unresolvedRuntimeReferences.
   */
  readonly unresolved: readonly SourceGraphUnresolved[];
  /**
   * Bare specifiers (builtins, packages, workspace packages, tsconfig paths aliases) are reported here, not as edges;
   * consumers that need alias resolution resolve them themselves.
   */
  readonly external: readonly SourceGraphExternal[];
  /** Computed or otherwise unprovable loader references from the existing dependency parser. */
  readonly unresolvedRuntimeReferences: readonly SourceGraphRuntimeReference[];
  /** Files the parser could not read. Their imports are absent from `edges`. */
  readonly parseFailures: readonly string[];
  /** Per-file direct ESM runtime export facts; unsupported syntax never establishes a complete count. */
  readonly runtimeExports: readonly SourceGraphFileExports[];
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

const compareImports = (left: SourceGraphUnresolved, right: SourceGraphUnresolved): number =>
  compareBinaryStrings(left.from, right.from) || left.line - right.line || compareBinaryStrings(left.specifier, right.specifier);

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = source.indexOf("\n"); index !== -1 && index < offset; index = source.indexOf("\n", index + 1)) { line += 1; }
  return line;
}

function fileExports(file: ClassifiedSourceFile): SourceGraphFileExports {
  const { parsed } = file;
  return Object.freeze({
    path: file.path,
    status: parsed.parseErrorCount > 0 ? "parse-failure" : parsed.unsupportedExports.length > 0 ? "unsupported" : "complete",
    exports: Object.freeze(parsed.runtimeExports.map(({ name, kind, start }) =>
      Object.freeze({ name, kind, line: lineAt(file.source, start) }))),
    unsupported: Object.freeze(parsed.unsupportedExports.map(({ kind, start }) =>
      Object.freeze({ kind, line: lineAt(file.source, start) })))
  });
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
  const external: SourceGraphExternal[] = [];
  for (const edge of graph.edges) {
    const at = { from: edge.fromPath, specifier: edge.specifier, kind: edge.kind, mode: edge.mode, line: line(edge.fromPath, edge.start) };
    const { resolution } = edge;
    switch (resolution.kind) {
      case "local-file":
        edges.push({ from: edge.fromPath, to: resolution.path, kind: edge.kind, mode: edge.mode, line: at.line });
        break;
      case "builtin":
      case "external-package":
      case "workspace-package":
      case "self-workspace-package":
        external.push(at);
        break;
      // Anything that is neither an edge nor a bare specifier is visible rather than dropped, including a
      // target that exists only as build output (for example "../dist/index.js").
      case "generated-output-candidate":
      case "unsupported":
      case "unresolved":
        unresolved.push(at);
        break;
      default: {
        const exhaustive: never = resolution;
        throw new Error(`Unhandled source dependency resolution: ${JSON.stringify(exhaustive)}.`);
      }
    }
  }
  return Object.freeze({
    files: Object.freeze(graph.nodes.map(({ path }) => path).toSorted(compareBinaryStrings)),
    edges: Object.freeze(edges.toSorted((left, right) => compareBinaryStrings(left.from, right.from) || compareBinaryStrings(left.to, right.to) || left.line - right.line)),
    unresolved: Object.freeze(unresolved.toSorted(compareImports)),
    external: Object.freeze(external.toSorted(compareImports)),
    unresolvedRuntimeReferences: Object.freeze(graph.unresolvedRuntimeReferences.map(({ path, kind, start }) =>
      Object.freeze({ from: path, kind, line: line(path, start) }))),
    parseFailures: Object.freeze(graph.parseFailures.map(({ path }) => path)),
    runtimeExports: Object.freeze(classifiedFiles.map(fileExports).toSorted((left, right) => compareBinaryStrings(left.path, right.path)))
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
