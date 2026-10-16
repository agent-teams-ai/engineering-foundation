import { diagnostic, isPortablePath } from '../../feature-model/domain/model.js';
import type {
  Diagnostic, FeatureModuleInput, FeatureNode, ImportRecord, LayerRole, SurfaceKind,
} from '../../feature-model/domain/model.js';
import type { FeatureTree } from '../../feature-layout/application/analyze-feature-tree.js';
import { cyclicComponents, findCycles } from './feature-graphs.js';
import type { Edge } from './feature-graphs.js';
import { layerDirectionAllowed } from './layer-direction.js';

type Direction = 'upward' | 'downward' | 'lateral';
type UseEdge = Readonly<{ from: FeatureNode; to: FeatureNode; direction: Direction; path: string; line: number }>;
type Context = Readonly<{
  input: FeatureModuleInput;
  tree: FeatureTree;
  surfaces: ReadonlyMap<string, ReadonlySet<SurfaceKind>>;
  problems: Diagnostic[];
  uses: Map<string, UseEdge>;
  wired: Set<string>;
  republished: ReadonlySet<string>;
  /** Whether the module declares a sub-feature; republication is a rule of such modules only. */
  nested: boolean;
}>;

const isAncestor = (ancestor: FeatureNode, node: FeatureNode): boolean => node.id.startsWith(`${ancestor.id}/`);
// A top-level feature is visible to the module; a sub-feature to its parent and the parent's descendants.
const visible = (from: FeatureNode | undefined, to: FeatureNode): boolean =>
  to.parent === undefined || (from !== undefined && (from.id === to.parent || from.id.startsWith(`${to.parent}/`)));
const directionOf = (from: FeatureNode, to: FeatureNode): Direction =>
  isAncestor(to, from) ? 'upward' : to.parent === from.id ? 'downward' : 'lateral';
const pairKey = (...parts: readonly string[]): string => parts.join('\u0000');

function indexSurfaces(input: FeatureModuleInput, tree: FeatureTree, problems: Diagnostic[]): Map<string, Set<SurfaceKind>> {
  const index = new Map<string, Set<SurfaceKind>>();
  const mapped: ReadonlyArray<readonly [SurfaceKind, readonly string[] | undefined]> = [
    ['public', input.surfaces?.public], ['internal-api', input.surfaces?.internalApi],
    ['composition-contract', input.surfaces?.compositionContract], ['composition-surface', input.surfaces?.compositionSurface],
    ['testing', input.surfaces?.testing],
  ];
  for (const [kind, files] of mapped) {
    for (const file of files ?? []) {
      if (tree.ownerOf(file) === undefined) {
        problems.push(diagnostic('surface-unowned', `${file}: a ${kind} surface file belongs to no feature.`, { path: file }));
      }
      if (kind === 'composition-contract' && tree.roleOf(file) !== 'composition') {
        problems.push(diagnostic('composition-contract-misplaced', `${file}: a composition contract is composition code of its feature.`, { path: file }));
      }
      index.set(file, (index.get(file) ?? new Set<SurfaceKind>()).add(kind));
    }
  }
  return index;
}

// One import record with everything the edge rules need to judge it.
type View = Readonly<{
  record: ImportRecord;
  from: FeatureNode | undefined;
  to: FeatureNode;
  fromRole: LayerRole | undefined;
  toRole: LayerRole | undefined;
  kinds: ReadonlySet<SurfaceKind>;
}>;
const arrow = ({ record }: View): string => `${record.from} -> ${record.to}`;
const at = ({ record }: View): Readonly<{ path: string; line: number }> => ({ path: record.from, line: record.line });

function sameFeatureEdge(ctx: Context, view: View): void {
  const { fromRole, toRole } = view;
  if (view.kinds.has('composition-contract') && fromRole !== 'composition') {
    ctx.problems.push(diagnostic('composition-contract-layer',
      `${arrow(view)}: only composition code may depend on a composition contract, its own feature's included.`, at(view)));
  } else if (fromRole !== undefined && toRole !== undefined && !layerDirectionAllowed(fromRole, toRole, 'same-feature')) {
    ctx.problems.push(diagnostic('layer-direction', `${arrow(view)}: ${fromRole} cannot import ${toRole}.`, at(view)));
  }
}

const republishable = (kinds: ReadonlySet<SurfaceKind> | undefined): readonly ('public' | 'composition-contract')[] =>
  (['public', 'composition-contract'] as const).filter((kind) => kinds?.has(kind) === true);

// A re-export from a public or composition-contract surface to such a surface is a republication, never a use edge.
function republication(ctx: Context, view: View): boolean {
  const { record, from, to, kinds } = view;
  const own = republishable(ctx.surfaces.get(record.from));
  const target = republishable(kinds);
  if (!ctx.nested || from === undefined || record.reexport !== true || own.length === 0 || target.length === 0) { return false; }
  const surface = own.find((kind) => target.includes(kind));
  if (to.parent !== from.id) {
    ctx.problems.push(isAncestor(from, to)
      ? diagnostic('republication-skips-level', `${arrow(view)}: ${from.id} republishes only from its direct sub-features, not from ${to.id}.`, at(view))
      : diagnostic('republication-not-sub-feature', `${arrow(view)}: ${from.id} republishes only from its direct sub-features, and ${to.id} is not one.`, at(view)));
  } else if (surface === undefined) {
    ctx.problems.push(diagnostic('republication-mismatch', `${arrow(view)}: a republication re-exports the same surface of its parent, not another one.`, at(view)));
  } else if (!ctx.republished.has(pairKey(from.id, to.id, surface))) {
    ctx.problems.push(diagnostic('republication-undeclared', `${arrow(view)}: ${from.id} republishes the ${surface} of ${to.id} without a declaration.`, at(view)));
  }
  return true;
}

// Composition code is the composition role of a feature and, outside every feature, the module-level files the profile names.
const composes = (ctx: Context, view: View): boolean =>
  view.fromRole === 'composition' ||
  (view.from === undefined && (ctx.input.moduleComposition === undefined || ctx.input.moduleComposition.includes(view.record.from)));

function assemblyEdge(ctx: Context, view: View): void {
  const { from, to } = view;
  if (to.parent === undefined) {
    if (!composes(ctx, view)) {
      ctx.problems.push(diagnostic('deep-import', `${arrow(view)}: only composition code wires the composition surface of ${to.id}.`, at(view)));
    }
    return;
  }
  if (from?.id === to.parent && view.fromRole === 'composition') {
    if (view.record.mode === 'runtime') { ctx.wired.add(to.id); }
    return;
  }
  ctx.problems.push(diagnostic('assembly-misplaced', `${arrow(view)}: only the feature composition of ${to.parent} wires ${to.id}.`, at(view)));
}

function layerOfUse(ctx: Context, view: View): void {
  const { from, fromRole, kinds } = view;
  if (kinds.has('composition-contract') && !composes(ctx, view)) {
    ctx.problems.push(diagnostic('composition-contract-layer', `${arrow(view)}: only composition code may depend on a composition contract.`, at(view)));
    return;
  }
  // A public entrypoint outside any role directory is still a transport contract surface.
  const target = view.toRole ?? (kinds.has('public') ? 'contracts' : undefined);
  if (from !== undefined && fromRole !== undefined && target !== undefined && !layerDirectionAllowed(fromRole, target, 'other-feature')) {
    ctx.problems.push(diagnostic('layer-direction', `${arrow(view)}: ${fromRole} cannot import ${target} of another feature.`, at(view)));
  }
}

function recordUse(ctx: Context, view: View, from: FeatureNode, declared = true): void {
  const key = pairKey(from.id, view.to.id);
  if (!ctx.uses.has(key)) { ctx.uses.set(key, { from, to: view.to, direction: directionOf(from, view.to), ...at(view) }); }
  if (declared && ctx.input.useEdges !== undefined && !ctx.input.useEdges.some((edge) => edge.from === from.id && edge.to === view.to.id)) {
    ctx.problems.push(diagnostic('use-undeclared', `${from.id} -> ${view.to.id}: a use edge missing from the declared feature graph.`, at(view)));
  }
}

function crossFeatureEdge(ctx: Context, view: View): void {
  if (republication(ctx, view)) { return; }
  const assembly = view.kinds.has('composition-surface');
  if (assembly) { assemblyEdge(ctx, view); }
  const curated = view.kinds.has('public') || view.kinds.has('internal-api') || view.kinds.has('composition-contract');
  if (!curated && assembly) { return; }
  if (!visible(view.from, view.to)) {
    ctx.problems.push(diagnostic('not-visible', `${arrow(view)}: ${view.to.id} is not visible to its dependent.`, at(view)));
  } else if (!curated) {
    // A deep import breaks the surface rule and may break the direction rule too; both are reported.
    ctx.problems.push(diagnostic('deep-import', `${arrow(view)}: not a curated surface of ${view.to.id}.`, at(view)));
    layerOfUse(ctx, view);
    // The edge still exists: it counts for cycles, though it needs no declaration to be rejected.
    if (view.from !== undefined) { recordUse(ctx, view, view.from, false); }
  } else {
    layerOfUse(ctx, view);
    if (view.from !== undefined) { recordUse(ctx, view, view.from); }
  }
}

// A test belongs to the deepest feature whose test root contains it: it may use that feature's internals and, of a
// visible feature, the public entrypoints, internal APIs and testing surfaces. Test edges are no use edges.
function testEdge(ctx: Context, record: ImportRecord, owner: FeatureNode, to: FeatureNode): void {
  if (owner === to) { return; }
  const kinds = ctx.surfaces.get(record.to) ?? new Set<SurfaceKind>();
  const where = { path: record.from, line: record.line };
  const arrowText = `${record.from} -> ${record.to}`;
  if (!visible(owner, to)) {
    ctx.problems.push(diagnostic('not-visible', `${arrowText}: ${to.id} is not visible to a test of ${owner.id}.`, where));
  } else if (!(kinds.has('public') || kinds.has('internal-api') || kinds.has('testing'))) {
    ctx.problems.push(diagnostic('deep-import', `${arrowText}: a test of ${owner.id} uses only public, internal API and testing surfaces of ${to.id}.`, where));
  }
}

function checkDeclarations(ctx: Context): void {
  const { input, tree, problems } = ctx;
  for (const { from, to, surface } of input.republications ?? []) {
    if (tree.node(to)?.parent !== from || tree.node(from) === undefined) {
      problems.push(diagnostic('republication-invalid', `${from} -> ${to}: ${surface} republication is declared from a direct sub-feature only.`));
    }
  }
  const declared: Edge[] = [];
  for (const { from, to } of input.useEdges ?? []) {
    const [source, target] = [tree.node(from), tree.node(to)];
    if (source === undefined || target === undefined) {
      problems.push(diagnostic('use-edge-invalid', `${from} -> ${to}: a declared use edge names an unknown feature.`));
    } else if (!visible(source, target)) {
      problems.push(diagnostic('not-visible', `${from} -> ${to}: ${to} is not visible to ${from}.`));
    } else if (directionOf(source, target) !== 'upward') { declared.push([from, to]); }
  }
  for (const cycle of findCycles(declared)) {
    problems.push(diagnostic('feature-cycle', `Declared feature graph: ${cycle.join(' -> ')}`));
  }
}

function checkGraphs(ctx: Context, loadEdges: readonly Edge[]): void {
  // Upward edges are outside the cycle graph; runtime and type-only references count alike.
  const observed = [...ctx.uses.values()].filter((edge) => edge.direction !== 'upward').map((edge): Edge => [edge.from.id, edge.to.id]);
  for (const cycle of findCycles(observed)) {
    ctx.problems.push(diagnostic('feature-cycle', `Observed feature graph: ${cycle.join(' -> ')}`));
  }
  for (const component of cyclicComponents(loadEdges)) {
    const owners = new Set(component.map((file) => ctx.tree.ownerOf(file)?.id));
    if (owners.size > 1) {
      ctx.problems.push(diagnostic('load-cycle', `Load-time import cycle between features: ${component.join(', ')}`, { path: component[0] ?? '' }));
    }
  }
  for (const node of ctx.tree.nodes) {
    const exposes = [...ctx.surfaces].some(([file, kinds]) => kinds.has('composition-surface') && ctx.tree.ownerOf(file) === node);
    if (node.parent !== undefined && exposes && !ctx.wired.has(node.id)) {
      ctx.problems.push(diagnostic('assembly-missing', `${node.id}: its composition surface is not wired by the feature composition of ${node.parent}.`, { path: node.root }));
    }
  }
}

/** Edge rules: visibility, curated surfaces, layer direction, composition contracts, assembly, republication, cycles. */
export function checkFeatureDependencies(input: FeatureModuleInput, tree: FeatureTree): readonly Diagnostic[] {
  const problems: Diagnostic[] = [];
  const ctx: Context = {
    input, tree, problems, surfaces: indexSurfaces(input, tree, problems), uses: new Map(), wired: new Set(),
    nested: tree.nodes.some((node) => node.parent !== undefined),
    republished: new Set((input.republications ?? []).map(({ from, to, surface }) => pairKey(from, to, surface))),
  };
  const loadEdges: Edge[] = [];
  const testFiles = new Set(input.testFiles ?? []);
  for (const record of input.imports) {
    if (!isPortablePath(record.from) || !isPortablePath(record.to)) {
      problems.push(diagnostic('invalid-path', `${record.from} -> ${record.to}: not a repository-relative path with / separators.`));
      continue;
    }
    const [from, to] = [tree.ownerOf(record.from), tree.ownerOf(record.to)];
    if (to === undefined) { continue; }
    if (testFiles.has(record.from)) {
      const owner = tree.testOwnerOf(record.from) ?? from;
      if (owner !== undefined) { testEdge(ctx, record, owner, to); }
      continue;
    }
    if (record.mode === 'runtime' && from !== undefined) { loadEdges.push([record.from, record.to]); }
    const view: View = {
      record, from, to, fromRole: tree.roleOf(record.from), toRole: tree.roleOf(record.to),
      kinds: ctx.surfaces.get(record.to) ?? new Set<SurfaceKind>(),
    };
    if (from === to) { sameFeatureEdge(ctx, view); } else { crossFeatureEdge(ctx, view); }
  }
  checkDeclarations(ctx);
  checkGraphs(ctx, loadEdges);
  return problems;
}
