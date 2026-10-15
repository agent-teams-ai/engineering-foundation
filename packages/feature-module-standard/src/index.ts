export { checkFeatureModule } from './features/module-check/application/check-feature-module.js';
export { analyzeFeatureTree } from './features/feature-layout/application/analyze-feature-tree.js';
export type { FeatureTree } from './features/feature-layout/application/analyze-feature-tree.js';
export { findOverlappingRoots } from './features/feature-layout/application/find-overlapping-roots.js';
export { layerDirectionAllowed } from './features/feature-dependencies/application/layer-direction.js';
export type { LayerScope } from './features/feature-dependencies/application/layer-direction.js';
export { cyclicComponents, findCycles } from './features/feature-dependencies/application/feature-graphs.js';
export { isWithin } from './features/feature-model/domain/model.js';
export type {
  Diagnostic, FeatureMetric, FeatureModuleInput, FeatureModuleReport, FeatureNode, ImportMode, ImportRecord,
  LayerRole, Republication, RepublishedSurface, Severity, SurfaceKind, SurfaceMap, UseEdge,
} from './features/feature-model/domain/model.js';
