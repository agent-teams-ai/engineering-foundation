export { checkFeatureModule } from './features/module-check/application/check-feature-module.js';
export { analyzeFeatureTree } from './features/feature-layout/application/analyze-feature-tree.js';
export type { FeatureTree, FeatureTreeAnalysis } from './features/feature-layout/application/analyze-feature-tree.js';
export { inferDirectoryLayout } from './features/feature-layout/application/infer-directory-layout.js';
export type { DirectoryLayout } from './features/feature-layout/application/infer-directory-layout.js';
export { findOverlappingRoots } from './features/feature-layout/application/find-overlapping-roots.js';
export { layerDirectionAllowed } from './features/feature-dependencies/application/layer-direction.js';
export type { LayerScope } from './features/feature-dependencies/application/layer-direction.js';
export { findCycles } from './features/feature-dependencies/application/feature-graphs.js';
export type { Edge } from './features/feature-dependencies/application/feature-graphs.js';
export { ERROR_CODES, STANDARD, WARNING_CODES, isWithin } from './features/feature-model/domain/model.js';
export type {
  Diagnostic, DiagnosticCode, FeatureMetric, FeatureModuleInput, FeatureModuleReport, FeatureNode, ImportMode, ImportRecord,
  LayerRole, Republication, RoleRoot, RepublishedSurface, Severity, SurfaceKind, SurfaceMap, UseEdge,
} from './features/feature-model/domain/model.js';
