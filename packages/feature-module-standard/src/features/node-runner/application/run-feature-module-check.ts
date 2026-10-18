import { inferDirectoryLayout } from '../../feature-layout/application/infer-directory-layout.js';
import { checkFeatureModule } from '../../module-check/application/check-feature-module.js';
import { ERROR_CODES, WARNING_CODES, isPortablePath, isWithin } from '../../feature-model/domain/model.js';
import type {
  Diagnostic, DiagnosticCode, FeatureMetric, FeatureModuleInput, FeatureNode, ImportRecord, LayerRole, Republication, RepublishedSurface,
  RoleRoot, Severity, SurfaceMap, UseEdge,
} from '../../feature-model/domain/model.js';

// The report and the configuration name kernel types and the closed code lists; the runner entry point republishes them.
export { ERROR_CODES, WARNING_CODES };
export type {
  Diagnostic, DiagnosticCode, FeatureMetric, FeatureNode, LayerRole, Republication, RepublishedSurface, RoleRoot, Severity, SurfaceMap, UseEdge,
};

/** A resolved import between two files, as a source graph reports it. */
export type GraphEdge = Readonly<{ from: string; to: string; mode: 'runtime' | 'type-only'; line: number; reexport?: true }>;
/** A literal reference whose target could not be established by the source producer. */
export type GraphUnresolved = Readonly<{ from: string; specifier: string; kind: string; mode: 'runtime' | 'type-only'; line: number }>;
/** A computed loader whose target is unavailable to the source producer. */
export type GraphRuntimeReference = Readonly<{ from: string; kind: string; line: number }>;
export type ObservedGraph = Readonly<{
  files: readonly string[]; edges: readonly GraphEdge[]; parseFailures: readonly string[];
  unresolved: readonly GraphUnresolved[]; unresolvedRuntimeReferences: readonly GraphRuntimeReference[];
}>;

export type BudgetMeasurement = Readonly<{ subject: string; metric: string; value: number }>;
/** A ceiling for a metric; a threshold with a `subject` replaces the general one for that feature. */
export type BudgetThreshold = Readonly<{ metric: string; max: number; subject?: string }>;
export type BudgetWarning = BudgetMeasurement & Readonly<{ max: number }>;

/** What the runner needs from the outside: a file graph and the growth budget comparison. */
export type NodeRunnerPorts = Readonly<{
  observe: (roots: readonly string[]) => Promise<ObservedGraph>;
  checkBudgets: (input: Readonly<{ measurements: readonly BudgetMeasurement[]; thresholds: readonly BudgetThreshold[] }>) => readonly BudgetWarning[];
}>;

/** The default layout: `<features root>/<feature>/<role directory>`. */
export type DirectoryStructure = Readonly<{
  featuresRoot: string;
  roleDirectories: Readonly<Record<string, LayerRole>>;
  /** Declared sub-feature roots. Without them only the top-level features exist. */
  subFeatureRoots?: readonly string[];
}>;
/** The profile's own mapping, for a tree that does not follow the default layout. */
export type DeclaredStructure = Readonly<{
  featureRoots: readonly string[];
  roleRoots: readonly RoleRoot[];
  featuresRoots?: readonly string[];
}>;

/** Data only: every fact is declared, nothing is discovered beyond the files and their imports. */
export type NodeCheckConfig = Readonly<{
  consumerRoot: string;
  /** Repository-relative production roots. */
  sourceRoots: readonly string[];
  /** Repository-relative test roots; their files are the module's tests. */
  testRoots?: readonly string[];
  structure: DirectoryStructure | DeclaredStructure;
  mappedFiles?: readonly string[];
  testFeaturesRoot?: string;
  surfaces?: SurfaceMap;
  /** Module-level source files that the profile declares as composition. */
  moduleComposition?: readonly string[];
  republications?: readonly Republication[];
  useEdges?: readonly UseEdge[];
  depthWarning?: number;
  /** Named file groups to count per feature, as regular expression sources matched against the repository path. */
  fileGroups?: Readonly<Record<string, string>>;
  budgets?: readonly BudgetThreshold[];
}>;

export type NodeReport = Readonly<{
  ok: boolean;
  features: readonly FeatureNode[];
  diagnostics: readonly Diagnostic[];
  metrics: readonly FeatureMetric[];
  /** Files the parser could not read; their imports are missing from the check, so the run fails. */
  parseFailures: readonly string[];
  /** Missing or unsupported literal references keep source coverage incomplete. */
  unresolved: readonly GraphUnresolved[];
  /** Computed references cannot establish a complete architecture graph. */
  unresolvedRuntimeReferences: readonly GraphRuntimeReference[];
  budgetWarnings: readonly BudgetWarning[];
}>;

const inRoots = (path: string, roots: readonly string[]): boolean => roots.some((root) => isWithin(path, root));

function structureOf(config: NodeCheckConfig, files: readonly string[]): Pick<FeatureModuleInput, 'featureRoots' | 'featuresRoots' | 'roleRoots'> {
  const { structure } = config;
  if ('featureRoots' in structure) {
    return { featureRoots: structure.featureRoots, roleRoots: structure.roleRoots, ...(structure.featuresRoots === undefined ? {} : { featuresRoots: structure.featuresRoots }) };
  }
  return inferDirectoryLayout({ ...structure, files });
}

function measurementsOf(metrics: readonly FeatureMetric[]): BudgetMeasurement[] {
  return metrics.flatMap((metric) => [
    { subject: metric.id, metric: 'depth', value: metric.depth },
    { subject: metric.id, metric: 'subFeatures', value: metric.subFeatures },
    { subject: metric.id, metric: 'sourceFiles', value: metric.sourceFiles },
    { subject: metric.id, metric: 'testFiles', value: metric.testFiles },
    ...Object.entries(metric.groups).map(([name, value]) => ({ subject: metric.id, metric: name, value })),
  ]);
}

/**
 * Reads the declared roots through the file graph, runs the kernel over the module they hold and compares its per-feature
 * metrics with the declared growth budgets. Budgets only warn; every other result comes from the kernel unchanged.
 */
export async function runFeatureModuleCheck(config: NodeCheckConfig, ports: NodeRunnerPorts): Promise<NodeReport> {
  const testRoots = config.testRoots ?? [];
  const graph = await ports.observe([...config.sourceRoots, ...testRoots]);
  const testFiles = graph.files.filter((file) => inRoots(file, testRoots));
  const files = graph.files.filter((file) => !inRoots(file, testRoots));
  const known = new Set(graph.files);
  const imports: ImportRecord[] = graph.edges
    .filter((edge) => known.has(edge.from) && known.has(edge.to))
    .map((edge) => ({ from: edge.from, to: edge.to, mode: edge.mode, line: edge.line, ...(edge.reexport === true ? { reexport: true } : {}) }));
  const groups = Object.entries(config.fileGroups ?? {}).map(([name, source]): [string, RegExp] => [name, new RegExp(source, 'u')]);
  const structure = structureOf(config, files);
  const report = checkFeatureModule({
    ...structure,
    files, imports,
    ...(testFiles.length === 0 ? {} : { testFiles }),
    ...(config.testFeaturesRoot === undefined ? {} : { testFeaturesRoot: config.testFeaturesRoot }),
    ...(config.mappedFiles === undefined ? {} : { mappedFiles: config.mappedFiles }),
    ...(config.surfaces === undefined ? {} : { surfaces: config.surfaces }),
    ...(config.moduleComposition === undefined ? {} : { moduleComposition: config.moduleComposition }),
    ...(config.republications === undefined ? {} : { republications: config.republications }),
    ...(config.useEdges === undefined ? {} : { useEdges: config.useEdges }),
    ...(config.depthWarning === undefined ? {} : { depthWarning: config.depthWarning }),
    ...(groups.length === 0 ? {} : { fileGroups: Object.fromEntries(groups.map(([name, pattern]) => [name, (path: string) => pattern.test(path)])) }),
  });
  const unmappedTests = testFiles.filter((file) => isPortablePath(file) &&
    !structure.featureRoots.some((root) => isWithin(file, root)) &&
    !(config.testFeaturesRoot !== undefined && file.startsWith(`${config.testFeaturesRoot}/`)));
  if (unmappedTests.length > 0 && !report.diagnostics.some(({ code }) => code === 'invalid-path')) {
    throw new Error(`Test files require a feature root or testFeaturesRoot mapping: ${unmappedTests.join(', ')}.`);
  }
  const budgetWarnings = ports.checkBudgets({ measurements: measurementsOf(report.metrics), thresholds: config.budgets ?? [] });
  return {
    ok: report.ok && graph.parseFailures.length === 0 && graph.unresolved.length === 0 && graph.unresolvedRuntimeReferences.length === 0,
    features: report.features, diagnostics: report.diagnostics, metrics: report.metrics,
    parseFailures: graph.parseFailures, unresolved: graph.unresolved,
    unresolvedRuntimeReferences: graph.unresolvedRuntimeReferences, budgetWarnings,
  };
}

/** One line per finding: `error code path:line message`, then unreadable files and budget warnings. */
export function formatNodeReport(report: NodeReport): string {
  const lines = [
    ...report.diagnostics.map(({ severity, code, path, line, message }) =>
      `${severity} ${code} ${path === undefined ? '' : `${path}${line === undefined ? '' : `:${String(line)}`} `}${message}`),
    ...report.parseFailures.map((path) => `error unreadable-file ${path}`),
    ...report.unresolved.map(({ from, line, specifier }) => `error unresolved-reference ${from}:${String(line)} ${specifier}`),
    ...report.unresolvedRuntimeReferences.map(({ from, line, kind }) => `error unresolved-runtime-reference ${from}:${String(line)} ${kind}`),
    ...report.budgetWarnings.map(({ subject, metric, value, max }) => `warning budget ${subject}: ${metric} is ${String(value)}, budget ${String(max)}`),
  ];
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
