export { analyzeSourceDependencies } from "./application/use-cases/analyze-source-dependencies.js";
export { buildObservedSourceGraph } from "./application/use-cases/build-observed-source-graph.js";
export type { AnalyzeSourceDependenciesInput, AnalyzeSourceDependenciesDependencies } from "./application/use-cases/analyze-source-dependencies.js";
export type { SourceFileSnapshot } from "./application/model/source-file-snapshot.js";
export type { SourceTreeReader } from "./application/ports/source-tree-reader.js";
export type { SourceDependencyParser } from "./application/ports/source-dependency-parser.js";
export type { SourceDependencyResolver } from "./application/ports/source-dependency-resolver.js";
export type { SourceWorkspaceTopologyInspector, SourceWorkspaceInventorySnapshotReader } from "./application/ports/source-workspace-topology-inspector.js";
export type { SourceWorkspaceFileReader, SourceWorkspaceManifestLoader } from "./application/ports/source-workspace-evidence-reader.js";
export {
  assertSourceFileByteLimit,
  assertSourceManifestByteLimit,
  assertSourceTopologyActive,
  isSourceTopologyProblem,
  rejectSourceFileRead,
  sourceTopologyInputError
} from "./application/policies/source-topology-evidence.js";
