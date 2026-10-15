import { diagnostic, isPortablePath } from '../../feature-model/domain/model.js';
import type { Diagnostic, FeatureMetric, FeatureModuleInput, FeatureModuleReport } from '../../feature-model/domain/model.js';
import { analyzeFeatureTree } from '../../feature-layout/application/analyze-feature-tree.js';
import type { FeatureTreeAnalysis } from '../../feature-layout/application/analyze-feature-tree.js';
import { checkFeatureDependencies } from '../../feature-dependencies/application/check-feature-dependencies.js';

function metricsOf(input: FeatureModuleInput, { tree, testsOwned }: FeatureTreeAnalysis): FeatureMetric[] {
  const owned = input.files.filter((file) => isPortablePath(file)).map((file) => ({ file, owner: tree.ownerOf(file)?.id }));
  return tree.nodes.map((node) => {
    const files = owned.filter(({ owner }) => owner === node.id).map(({ file }) => file);
    return {
      id: node.id, depth: node.depth, sourceFiles: files.length, testFiles: testsOwned.get(node.id) ?? 0,
      subFeatures: tree.nodes.filter((other) => other.parent === node.id).length,
      groups: Object.fromEntries(Object.entries(input.fileGroups ?? {}).map(([name, matches]) => [name, files.filter(matches).length])),
    };
  });
}

const compare = (a: Diagnostic, b: Diagnostic): number => {
  const left = `${a.code}\u0000${a.path ?? ''}\u0000${String(a.line ?? 0).padStart(9, '0')}\u0000${a.message}`;
  const right = `${b.code}\u0000${b.path ?? ''}\u0000${String(b.line ?? 0).padStart(9, '0')}\u0000${b.message}`;
  return left < right ? -1 : left > right ? 1 : 0;
};

/**
 * Validates the declared structure of one production module against the Feature Module Standard. It reads no
 * files and widens no policy: every fact, from roots and roles to surfaces and republications, is input.
 */
export function checkFeatureModule(input: FeatureModuleInput): FeatureModuleReport {
  const analysis = analyzeFeatureTree(input);
  const problems = [...analysis.diagnostics, ...checkFeatureDependencies(input, analysis.tree)];
  for (const node of input.depthWarning === undefined ? [] : analysis.tree.nodes.filter(({ depth }) => depth > (input.depthWarning ?? 0))) {
    problems.push(diagnostic('depth-warning', `${node.id}: depth ${node.depth} exceeds ${input.depthWarning}.`, { path: node.root }, 'warning'));
  }
  const diagnostics = problems.toSorted(compare);
  return {
    ok: !diagnostics.some(({ severity }) => severity === 'error'),
    features: analysis.tree.nodes, diagnostics, metrics: metricsOf(input, analysis),
  };
}
