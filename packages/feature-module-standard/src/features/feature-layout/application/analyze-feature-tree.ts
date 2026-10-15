import { FEATURE_CONTAINER, diagnostic, isPortablePath, isWithin } from '../../feature-model/domain/model.js';
import type { Diagnostic, FeatureModuleInput, FeatureNode, LayerRole } from '../../feature-model/domain/model.js';

export type FeatureTree = Readonly<{
  nodes: readonly FeatureNode[];
  node: (id: string) => FeatureNode | undefined;
  /** The deepest feature whose root contains the path. */
  ownerOf: (path: string) => FeatureNode | undefined;
  /** The role directory a path sits in, directly below its owning feature root. */
  roleOf: (path: string) => LayerRole | undefined;
  /** The deepest feature whose test root contains the path. */
  testOwnerOf: (path: string) => FeatureNode | undefined;
}>;

const segments = (path: string): string[] => path.split('/');
const lastSegment = (path: string): string => segments(path).at(-1) ?? path;

// Without a declaration only top-level features exist: a sub-feature is a declared fact, never inferred from a name.
function deriveRoots(featuresRoot: string, files: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    const rest = file.startsWith(`${featuresRoot}/`) ? segments(file.slice(featuresRoot.length + 1)) : [];
    if (rest.length >= 2) { roots.add(`${featuresRoot}/${rest[0] ?? ''}`); }
  }
  return [...roots];
}

function placement(root: string, parent: string | undefined, featuresRoot: string): boolean {
  const base = parent === undefined ? `${featuresRoot}/` : `${parent}/${FEATURE_CONTAINER}/`;
  return root.startsWith(base) && root.length > base.length && !root.slice(base.length).includes('/');
}

function buildNodes(featuresRoot: string, declared: readonly string[], problems: Diagnostic[]): FeatureNode[] {
  const roots = [...new Set(declared)].toSorted((a, b) => segments(a).length - segments(b).length || (a < b ? -1 : 1));
  for (const root of roots.filter((candidate) => declared.indexOf(candidate) !== declared.lastIndexOf(candidate))) {
    problems.push(diagnostic('feature-duplicate', `${root}: a feature root is declared more than once.`, { path: root }));
  }
  const nodes: FeatureNode[] = [];
  for (const root of roots) {
    const parentRoot = nodes.filter((node) => root.startsWith(`${node.root}/`)).at(-1);
    if (!placement(root, parentRoot?.root, featuresRoot)) {
      problems.push(diagnostic('feature-root-placement', parentRoot === undefined
        ? `${root}: a feature root must be ${featuresRoot}/<name>.`
        : `${root}: a sub-feature root must be ${parentRoot.root}/${FEATURE_CONTAINER}/<name>.`, { path: root }));
    }
    const name = lastSegment(root);
    nodes.push({
      id: parentRoot === undefined ? name : `${parentRoot.id}/${name}`, name, root,
      ...(parentRoot === undefined ? {} : { parent: parentRoot.id }), depth: (parentRoot?.depth ?? 0) + 1,
    });
  }
  return nodes;
}

type Entry = Readonly<{ name: string; directory: boolean }>;

// Direct children of a directory as the files and empty directories reveal them.
function entriesOf(dir: string, paths: readonly string[], emptyDirectories: readonly string[]): Entry[] {
  const entries = new Map<string, boolean>();
  for (const path of paths) {
    if (!path.startsWith(`${dir}/`)) { continue; }
    const rest = segments(path.slice(dir.length + 1));
    entries.set(rest[0] ?? '', rest.length > 1 || entries.get(rest[0] ?? '') === true);
  }
  for (const path of emptyDirectories) {
    const rest = path.startsWith(`${dir}/`) ? segments(path.slice(dir.length + 1)) : [];
    if (rest.length > 0) { entries.set(rest[0] ?? '', true); }
  }
  return [...entries].map(([name, directory]) => ({ name, directory }));
}

function checkContainer(
  container: string, nodes: readonly FeatureNode[], entries: readonly Entry[], problems: Diagnostic[],
  options: Readonly<{ top: boolean }>,
): void {
  for (const entry of entries) {
    const path = `${container}/${entry.name}`;
    if (!entry.directory) {
      problems.push(diagnostic('container-file', `${path}: the features container holds only feature directories.`, { path }));
    } else if (!nodes.some((node) => node.root === path)) {
      problems.push(diagnostic('feature-undeclared', `${path}: a directory of the features container is not a declared feature.`, { path }));
    }
  }
  if (!options.top && !nodes.some((node) => node.root.startsWith(`${container}/`))) {
    problems.push(diagnostic('container-empty', `${container}: the container exists only when it holds a sub-feature.`, { path: container }));
  }
}

function checkEntries(
  node: FeatureNode, entries: readonly Entry[], input: FeatureModuleInput, nested: boolean, problems: Diagnostic[],
): void {
  for (const { name, directory } of entries) {
    const mapped = directory
      ? (nested && name === FEATURE_CONTAINER) || Object.hasOwn(input.roleDirectories, name)
      : (input.mappedFiles ?? []).includes(name);
    if (nested && !mapped) {
      problems.push(diagnostic('entry-unmapped',
        `${node.root}/${name}: not a role directory, the sub-feature container or a mapped file.`, { path: `${node.root}/${name}` }));
    }
  }
}

function deepest(path: string, nodes: readonly FeatureNode[], rootOf: (node: FeatureNode) => string): FeatureNode | undefined {
  return nodes.filter((node) => isWithin(path, rootOf(node))).at(-1);
}

// Test root of `a/b` is `<testFeaturesRoot>/a/features/b`; walk the mirrored path down.
function testOwner(path: string, testRoot: string, byId: ReadonlyMap<string, FeatureNode>, nested: boolean): Readonly<{
  owner?: FeatureNode; rest: readonly string[]; unowned?: string;
}> {
  const parts = segments(path.slice(testRoot.length + 1));
  const first = parts[0] === undefined || parts.length < 2 ? undefined : byId.get(parts[0]);
  if (first === undefined) { return { rest: parts, unowned: 'a test sits directly in the test features root or in a directory that is no feature' }; }
  if (!nested) { return { owner: first, rest: parts.slice(1) }; }
  let owner = first;
  let index = 1;
  while (parts[index] === FEATURE_CONTAINER && index + 2 < parts.length) {
    const child = byId.get(`${owner.id}/${parts[index + 1] ?? ''}`);
    if (child === undefined) { return { owner, rest: parts.slice(index), unowned: `${parts[index + 1] ?? ''} is no sub-feature of ${owner.id}` }; }
    owner = child;
    index += 2;
  }
  return { owner, rest: parts.slice(index) };
}

export type FeatureTreeAnalysis = Readonly<{ tree: FeatureTree; diagnostics: readonly Diagnostic[]; testsOwned: ReadonlyMap<string, number> }>;

function checkTests(
  input: FeatureModuleInput, byId: ReadonlyMap<string, FeatureNode>, nested: boolean, problems: Diagnostic[],
): Map<string, number> {
  const testsOwned = new Map<string, number>();
  const testRoot = input.testFeaturesRoot;
  const portable = (input.testFiles ?? []).filter((file) => isPortablePath(file));
  const inRoot = portable.filter((file) => testRoot !== undefined && file.startsWith(`${testRoot}/`));
  // A test colocated with its source belongs to the deepest feature whose source root contains it.
  const inRootSet = new Set(inRoot);
  for (const file of portable.filter((candidate) => !inRootSet.has(candidate))) {
    const owner = deepest(file, [...byId.values()], (node) => node.root);
    if (owner !== undefined) { testsOwned.set(owner.id, (testsOwned.get(owner.id) ?? 0) + 1); }
  }
  for (const path of inRoot) {
    const { owner, rest, unowned } = testOwner(path, testRoot ?? '', byId, nested);
    if (unowned !== undefined) { problems.push(diagnostic('test-unowned', `${path}: ${unowned}.`, { path })); }
    if (owner === undefined) { continue; }
    testsOwned.set(owner.id, (testsOwned.get(owner.id) ?? 0) + 1);
    const home = rest.length > 1 ? rest[0] : undefined;
    if (home !== undefined && nested && home !== FEATURE_CONTAINER && byId.has(`${owner.id}/${home}`)) {
      problems.push(diagnostic('test-misplaced',
        `${path}: tests of ${owner.id}/${home} live in ${FEATURE_CONTAINER}/${home}/ of the mirrored test root.`, { path }));
    }
  }
  return testsOwned;
}

function checkDirectories(
  input: FeatureModuleInput, nodes: readonly FeatureNode[], files: readonly string[], nested: boolean, problems: Diagnostic[],
): void {
  const emptyDirectories = (input.emptyDirectories ?? []).filter((path) => isPortablePath(path));
  checkContainer(input.featuresRoot, nodes, entriesOf(input.featuresRoot, files, emptyDirectories), problems, { top: true });
  for (const node of nodes) {
    const entries = entriesOf(node.root, files, emptyDirectories);
    checkEntries(node, entries, input, nested, problems);
    const container = `${node.root}/${FEATURE_CONTAINER}`;
    const containerEntries = entriesOf(container, files, emptyDirectories);
    if (nested && (containerEntries.length > 0 || entries.some((entry) => entry.name === FEATURE_CONTAINER))) {
      checkContainer(container, nodes, containerEntries, problems, { top: false });
    }
  }
}

/** Tree rules: placement, container, entries, deepest ownership and mirrored test roots. */
export function analyzeFeatureTree(input: FeatureModuleInput): FeatureTreeAnalysis {
  const problems: Diagnostic[] = [];
  const files = input.files.filter((path) => isPortablePath(path));
  const surfaces = Object.values(input.surfaces ?? {}).flat();
  const declared = [input.featuresRoot, ...(input.testFeaturesRoot === undefined ? [] : [input.testFeaturesRoot]), ...(input.featureRoots ?? [])];
  for (const path of [...declared, ...surfaces, ...input.files, ...(input.emptyDirectories ?? []), ...(input.testFiles ?? [])]) {
    if (!isPortablePath(path)) { problems.push(diagnostic('invalid-path', `${path}: not a repository-relative path with / separators.`, { path })); }
  }
  const nodes = buildNodes(input.featuresRoot, input.featureRoots ?? deriveRoots(input.featuresRoot, files), problems);
  const nested = nodes.some((node) => node.parent !== undefined);
  checkDirectories(input, nodes, files, nested, problems);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const testsOwned = checkTests(input, byId, nested, problems);
  const testRoot = input.testFeaturesRoot;
  const ordered = nodes.toSorted((a, b) => (a.root < b.root ? -1 : 1));
  const tree: FeatureTree = {
    nodes: ordered,
    node: (id) => byId.get(id),
    ownerOf: (path) => deepest(path, nodes, (node) => node.root),
    roleOf: (path) => {
      const owner = deepest(path, nodes, (node) => node.root);
      const parts = owner === undefined ? [] : segments(path.slice(owner.root.length + 1));
      const role = parts.length > 1 ? input.roleDirectories[parts[0] ?? ''] : undefined;
      return role !== undefined && Object.hasOwn(input.roleDirectories, parts[0] ?? '') ? role : undefined;
    },
    testOwnerOf: (path) => (testRoot === undefined || !path.startsWith(`${testRoot}/`) ? undefined : testOwner(path, testRoot, byId, nested).owner),
  };
  return { tree, diagnostics: problems, testsOwned };
}
