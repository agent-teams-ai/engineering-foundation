import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type {
  JsonObject, JsonValue, ParsedRestorationLockInputs,
} from '../../application/model/restoration-lock-inputs.js';
import type {
  ManagedRestorationLockV1Diagnostic, ManagedRestorationLockV1Result,
  ManagedRestorationLockV1Provenance,
} from '../../application-api.js';
import { collectRestorationLockAnnotations } from './restoration-lock-annotations.js';
import { admitsCoveredArchiveRange } from './restoration-lock-covered-ranges.js';
import { admitRestorationLockInputs } from './restoration-lock-inputs.js';

type Path = readonly (string | number)[];
type Edges = Readonly<Record<string, string>>;
type RootBinding = JsonObject & { readonly specifier: string; readonly version: string };
type Importer = JsonObject & {
  readonly dependencies?: Readonly<Record<string, RootBinding>>;
  readonly devDependencies?: Readonly<Record<string, RootBinding>>;
  readonly optionalDependencies?: Readonly<Record<string, RootBinding>>;
};
type Package = JsonObject & { readonly resolution: JsonObject & { readonly integrity: string } };
type Snapshot = JsonObject & { readonly dependencies?: Edges; readonly optionalDependencies?: Edges };
type Lock = JsonObject & {
  readonly lockfileVersion: '9.0';
  readonly importers: Readonly<Record<string, Importer>>;
  readonly packages: Readonly<Record<string, Package>>;
  readonly snapshots: Readonly<Record<string, Snapshot>>;
};
const sections = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const roots: Edges = {
  '@agent-teams/docs-protocol': '0.6.0',
  '@agent-teams/docs-protocol-agent-teams': '0.2.9',
  '@agent-teams/engineering-foundation': '1.4.0',
};
const claims = [...Object.entries(roots).map(([name, version]) => `${name}@${version}`),
  '@agent-teams/document-authoring@0.3.0', '@agent-teams/repository-mutation@0.2.0'];
const contexts = [
  '@agent-teams/engineering-foundation@1.4.0', '@microsoft/api-extractor@7.58.12',
  '@microsoft/api-extractor-model@7.33.10', '@rushstack/node-core-library@5.23.3',
  '@rushstack/problem-matcher@0.2.1', '@rushstack/terminal@0.24.2',
  '@rushstack/ts-command-line@5.3.12',
];
const seeds = ['@rushstack/node-core-library@5.23.3',
  '@rushstack/problem-matcher@0.2.1', '@rushstack/terminal@0.24.2'];
const nodeTypes = '@types/node@24.13.3', undici = 'undici-types@7.18.2';
const suffix = '(@types/node@24.13.3)';
const formats = 'ajv-formats@3.0.1', formatsPeer = formats + '(ajv@8.20.0)';
const covered = [...contexts, nodeTypes, undici, 'ajv@8.20.0', formats, 'ajv-draft-04@1.0.0'];

class Refusal extends Error {
  readonly path: Path;
  constructor(message: string, path: Path) { super(message); this.path = path; }
}
function need(value: unknown, message: string, path: Path = []): asserts value {
  const accepted = Boolean(value);
  if (!accepted) {throw new Refusal(message, path);}
}
function isList(value: JsonValue | undefined): value is readonly JsonValue[] { return Array.isArray(value); }
function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === 'object' && !isList(value);
}
function object(value: JsonValue | undefined): JsonObject {
  need(isObject(value), 'expected record'); return value;
}
function isEdges(value: JsonObject): value is JsonObject & Edges {
  return Object.values(value).every(item => typeof item === 'string');
}
function strings(value: JsonValue | undefined): Edges {
  const row = object(value); need(isEdges(row), 'expected string edges'); return row;
}
function names(actual: readonly string[], expected: readonly string[], message: string): void {
  need(actual.length === expected.length && new Set(actual).size === actual.length &&
    actual.toSorted().join('\0') === expected.toSorted().join('\0'), message);
}
function exact(value: unknown, keys: readonly string[]): asserts value is Readonly<Record<string, unknown>> {
  need(value !== null && typeof value === 'object', 'request records must be plain data');
  need(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    'request records must be plain data');
  names(Reflect.ownKeys(value).map(key => { need(typeof key === 'string', 'symbol request key'); return key; }), keys,
    'unexpected or missing request field');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    need(Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true, 'request accessor or hidden field');
  }
}

function locator(text: string) {
  const cut = text.indexOf('('), coordinate = cut < 0 ? text : text.slice(0, cut);
  const context = cut < 0 ? '' : text.slice(cut);
  const match = /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+\.\d+)$/.exec(coordinate);
  need(match !== null && typeof match[1] === 'string' && match[1].length > 0 &&
    typeof match[2] === 'string' && match[2].length > 0, 'unsupported locator: ' + text);
  let end = 0; const peers = new Set<string>();
  for (const peer of context.matchAll(/\(((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@\d+\.\d+\.\d+\)/g)) {
    need(peer.index === end && typeof peer[1] === 'string' && peer[1].length > 0 &&
      !peers.has(peer[1]), 'ambiguous context: ' + text);
    peers.add(peer[1]); end += peer[0].length;
  }
  need(end === context.length, 'unsupported context: ' + text);
  return { coordinate, context, name: match[1], version: match[2] };
}
function edge(name: string, version: string): string {
  const id = `${name}@${version}`; need(locator(id).name === name, 'edge identity'); return id;
}
function edges(row: Snapshot): readonly (readonly [string, string])[] {
  return [...Object.entries(row.dependencies ?? {}), ...Object.entries(row.optionalDependencies ?? {})];
}
function assertLock(tree: JsonObject): asserts tree is Lock {
  need(tree.lockfileVersion === '9.0', 'pnpm-v9 string lockfileVersion', ['lockfileVersion']);
  const importers = object(tree.importers), packages = object(tree.packages), snapshots = object(tree.snapshots);
  for (const [id, value] of Object.entries(importers)) {
    const importer = object(value);
    for (const section of sections) {
      if (!Object.hasOwn(importer, section)) {continue;}
      for (const [name, item] of Object.entries(object(importer[section]))) {
        const binding = object(item);
        need(typeof binding.specifier === 'string' && typeof binding.version === 'string', 'importer binding', [id, section, name]);
        if (!binding.version.startsWith('link:')) {edge(name, binding.version);}
      }
    }
  }
  for (const [id, value] of Object.entries(packages)) {
    need(locator(id).context === '', 'package coordinate has context');
    need(typeof object(object(value).resolution).integrity === 'string', 'package resolution', ['packages', id]);
  }
  for (const [id, value] of Object.entries(snapshots)) {
    need(Object.hasOwn(packages, locator(id).coordinate), 'snapshot has no package', ['snapshots', id]);
    const row = object(value), seen = new Set<string>();
    for (const section of ['dependencies', 'optionalDependencies']) {
      if (!Object.hasOwn(row, section)) {continue;}
      for (const [name, version] of Object.entries(strings(row[section]))) {
        need(!seen.has(name), 'dependency occurs in two sections', ['snapshots', id, name]);
        seen.add(name); edge(name, version);
      }
    }
    if (Object.hasOwn(row, 'transitivePeerDependencies')) {
      const peers = row.transitivePeerDependencies;
      need(isList(peers) && peers.every(peer => typeof peer === 'string'), 'transitive peers', ['snapshots', id]);
    }
  }
}
function lock(tree: JsonObject): Lock { assertLock(tree); return tree; }

function starts(tree: Lock, foreign: boolean): string[] {
  const result: string[] = [];
  for (const [id, importer] of Object.entries(tree.importers)) {
    for (const section of sections) {for (const [name, binding] of Object.entries(importer[section] ?? {})) {
      if (foreign && id === '.' && Object.hasOwn(roots, name)) {continue;}
      if (!binding.version.startsWith('link:')) { result.push(edge(name, binding.version)); continue; }
      const target = posix.normalize(posix.join(id === '.' ? '' : id, binding.version.slice(5)));
      need(!posix.isAbsolute(target) && target !== '..' && !target.startsWith('../') &&
        Object.hasOwn(tree.importers, target), 'unbound workspace link');
    }}
  }
  return result;
}
function managedStarts(tree: Lock): string[] {
  const importer = tree.importers['.']; need(importer, 'missing managed importer');
  for (const section of ['dependencies', 'optionalDependencies']) {
    need(!Object.keys(object(importer[section] ?? {})).some(name => Object.hasOwn(roots, name)), 'moved managed root');
  }
  return Object.keys(roots).map(name => {
    const binding = importer.devDependencies?.[name]; need(binding, 'missing managed root');
    return edge(name, binding.version);
  });
}
function reach(tree: Lock, initial: readonly string[]): Set<string> {
  const found = new Set<string>(), pending = [...initial];
  while (pending.length) {
    const id = pending.pop(); need(id !== undefined && id.length > 0, 'reach cursor'); if (found.has(id)) {continue;}
    const row = tree.snapshots[id]; need(row, 'dangling locator', ['snapshots', id]); found.add(id);
    for (const [name, version] of edges(row)) {pending.push(edge(name, version));}
  }
  return found;
}
function rooted(tree: Lock): Set<string> {
  const found = reach(tree, starts(tree, false));
  names([...found], Object.keys(tree.snapshots), 'unreachable snapshot');
  names([...new Set([...found].map(id => locator(id).coordinate))], Object.keys(tree.packages), 'unused package');
  return found;
}

function canonical(value: JsonValue): string {
  if (isList(value)) {return '[' + value.map(canonical).join(',') + ']';}
  if (isObject(value)) {return '{' + Object.keys(value).toSorted().map(key => {
    const item = value[key]; need(item !== undefined, 'canonical own value');
    return JSON.stringify(key) + ':' + canonical(item);
  }).join(',') + '}';}
  return JSON.stringify(value);
}
function same(left: JsonValue | undefined, right: JsonValue | undefined, message: string): void {
  need(left !== undefined && right !== undefined && canonical(left) === canonical(right), message);
}
function kind(value: JsonValue | undefined): string {
  return value === undefined ? 'absent' : value === null ? 'null' : isList(value) ? 'array' : typeof value;
}
function compare(expected: JsonValue | undefined, actual: JsonValue | undefined, path: Path,
  diagnostics: ManagedRestorationLockV1Diagnostic[], code: 'mismatch' | 'preservation'): void {
  if (isObject(expected) && isObject(actual)) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].toSorted())
      {compare(expected[key], actual[key], [...path, key], diagnostics, code);}
  } else if (isList(expected) && isList(actual)) {
    for (let index = 0; index < Math.max(expected.length, actual.length); index++)
      {compare(expected[index], actual[index], [...path, index], diagnostics, code);}
  } else if (!Object.is(expected, actual)) {
    diagnostics.push({ code, path, message: `expected ${kind(expected)} differs from actual ${kind(actual)}` });
  }
}

function validateCoveredDeclarationRanges(snapshot: Snapshot, resolved: Edges,
  declared: { readonly required: Edges; readonly optional: Edges; readonly peers: Edges }): void {
  const { required, optional, peers } = declared;
  for (const [name, range] of [...Object.entries(required), ...Object.entries(optional), ...Object.entries(peers)]) {
    const version = resolved[name]; if (version === undefined) {continue;}
    need(admitsCoveredArchiveRange(range, locator(edge(name, version)).version, need), 'authenticated range does not admit edge');
    if (Object.hasOwn(required, name) && !Object.hasOwn(peers, name))
      {need(snapshot.dependencies?.[name] === version, 'required declaration became optional');}
    if (Object.hasOwn(optional, name)) {need(snapshot.optionalDependencies?.[name] === version, 'optional declaration became required');}
  }
}

function validateCoveredManifestDeclarations(coordinate: string, manifest: JsonObject, original: Lock,
  source: Lock): { optionalNode: string[]; overlaps: string[] } {
  const optionalNode: string[] = [], overlaps: string[] = [];
  const tree = coordinate === nodeTypes || coordinate === undici ? source : original;
  const ids = Object.keys(tree.snapshots).filter(id => locator(id).coordinate === coordinate);
  need(ids.length === 1 && ids[0] !== undefined && ids[0].length > 0, 'covered coordinate has ambiguous snapshots');
  const snapshot = tree.snapshots[ids[0]], pkg = tree.packages[coordinate]; need(snapshot && pkg, 'covered graph entry');
  const required = strings(manifest.dependencies ?? {});
  const optional = strings(manifest.optionalDependencies ?? {}), peers = strings(manifest.peerDependencies ?? {});
  const metadata = object(manifest.peerDependenciesMeta ?? {});
  same(pkg.peerDependencies ?? {}, manifest.peerDependencies ?? {}, 'authenticated package peers');
  same(pkg.peerDependenciesMeta ?? {}, metadata, 'authenticated package peer metadata');
  const resolved = Object.fromEntries(edges(snapshot)), expected = new Set([...Object.keys(required), ...Object.keys(optional)]);
  for (const [name, range] of Object.entries(peers)) {
    need(object(metadata[name]).optional === true, 'unsupported covered nonoptional peer');
    if (name === '@types/node') {
      need(range === '*' && resolved[name] === undefined && tree === original, 'original optional node peer');
      optionalNode.push(ids[0]);
    } else { need(resolved[name] !== undefined, 'missing covered peer'); expected.add(name); }
    if (Object.hasOwn(required, name)) {overlaps.push(`${coordinate}/${name}`);}
  }
  names(Object.keys(resolved), [...expected], 'covered archive/graph edge agreement');
  validateCoveredDeclarationRanges(snapshot, resolved, { required, optional, peers });
  return { optionalNode, overlaps };
}

function declarations(inputs: ParsedRestorationLockInputs, original: Lock, source: Lock): string[] {
  names(Object.keys(inputs.archives), covered, 'exact twelve covered archives');
  const optionalNode: string[] = [], overlaps: string[] = [];
  for (const coordinate of covered) {
    const archive = inputs.archives[coordinate]; need(archive, 'covered archive');
    const validated = validateCoveredManifestDeclarations(coordinate, archive.manifest, original, source);
    optionalNode.push(...validated.optionalNode);
    overlaps.push(...validated.overlaps);
  }
  names(optionalNode, seeds, 'exact three optional-node-peer seeds');
  names(overlaps, [formats + '/ajv'], 'exact covered dependency/optional-peer overlap');
  const formatManifest = inputs.archives[formats]?.manifest; need(formatManifest, 'formats manifest');
  need(strings(formatManifest.dependencies).ajv === '^8.0.0' && strings(formatManifest.peerDependencies).ajv === '^8.0.0', 'formats exact authenticated ranges');
  const parents = Object.entries(original.snapshots).filter(([, row]) => row.dependencies?.['ajv-formats'] !== undefined);
  names(parents.map(([id]) => id), ['@agent-teams/docs-protocol@0.6.0', contexts[0] ?? '', seeds[0] ?? ''], 'exact three formats parents');
  for (const [, row] of parents) {need(row.dependencies?.['ajv-formats'] === '3.0.1(ajv@8.20.0)' && row.dependencies.ajv === '8.20.0', 'formats parent AJV identity');}
  need(original.snapshots['@microsoft/tsdoc-config@0.18.2']?.dependencies?.ajv === '8.18.0', 'original tsdoc AJV');
  names(Object.keys(original.packages).filter(id => locator(id).name === 'ajv'), ['ajv@8.18.0', 'ajv@8.20.0'], 'two original AJVs');
  return optionalNode;
}
function supportedBoundary(row: JsonObject, packageEntry: boolean, formatEntry: boolean): void {
  const unsupported = packageEntry
    ? ['dependencies', 'optionalDependencies', 'dependenciesMeta', 'patchedDependencies', 'patched', 'id']
    : ['devDependencies', 'dependenciesMeta', 'patchedDependencies', 'patched', 'injected', 'id', 'resolution', 'name', 'version'];
  if (!packageEntry && !formatEntry) {unsupported.push('peerDependencies', 'peerDependenciesMeta');}
  need(!unsupported.some(key => Object.hasOwn(row, key)), 'unsupported transformed graph field');
}
function rewritten(row: Snapshot, rename: ReadonlyMap<string, string>): Snapshot {
  const result: Record<string, JsonValue> = { ...row };
  for (const section of ['dependencies', 'optionalDependencies']) {
    if (!Object.hasOwn(row, section)) {continue;}
    result[section] = Object.fromEntries(Object.entries(strings(row[section])).map(([name, version]) => {
      const replacement = rename.get(edge(name, version));
      return [name, replacement === undefined ? version : replacement.slice(name.length + 1)];
    }));
  }
  return result;
}

function validatedOriginalManagedImporter(envelope: JsonObject, original: Lock, originalAll: ReadonlySet<string>): Importer {
  need(envelope.packageCount === 83 && originalAll.size === 83 && Object.keys(original.packages).length === 83, 'rooted original83');
  names(Object.keys(original.importers), ['.'], 'original root importer');
  const rootImporter = original.importers['.']; need(rootImporter, 'original importer');
  names(Object.keys(rootImporter.devDependencies ?? {}), Object.keys(roots), 'exact original three roots');
  for (const [name, version] of Object.entries(roots)) {
    const binding = rootImporter.devDependencies?.[name];
    need(binding?.version === version && binding.specifier === version, 'original root coordinate');
  }
  need(isList(envelope.coordinates), 'original claims');
  names(envelope.coordinates.map(value => {
    const row = object(value); need(typeof row.name === 'string' && typeof row.version === 'string', 'claim identity');
    need(row.role === (Object.hasOwn(roots, row.name) ? 'direct' : 'transitive'), 'claim role');
    return `${row.name}@${row.version}`;
  }), claims, 'exact five original claims');
  need(isList(envelope.managedEdges), 'managed edges');
  names(envelope.managedEdges.map(value => {
    const row = object(value); need(typeof row.from === 'string' && typeof row.to === 'string', 'managed edge identity');
    return `${row.from}->${row.to}`;
  }), [
    '@agent-teams/docs-protocol->@agent-teams/document-authoring',
    '@agent-teams/docs-protocol->@agent-teams/repository-mutation',
    '@agent-teams/docs-protocol-agent-teams->@agent-teams/docs-protocol',
    '@agent-teams/docs-protocol-agent-teams->@agent-teams/repository-mutation',
    '@agent-teams/document-authoring->@agent-teams/repository-mutation',
    '@agent-teams/engineering-foundation->@agent-teams/document-authoring',
    '@agent-teams/engineering-foundation->@agent-teams/repository-mutation',
  ], 'original managed edge envelope');
  names([...reach(original, managedStarts(original))], [...originalAll], 'original managed closure');
  return rootImporter;
}

function reverseNodePeerAncestors(original: Lock, originalAll: ReadonlySet<string>, selectedSeeds: readonly string[]): Set<string> {
  const affected = new Set(selectedSeeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of originalAll) {
      const row = original.snapshots[id]; need(row, 'reverse graph entry');
      if (!affected.has(id) && edges(row).some(([name, version]) => affected.has(edge(name, version)))) {
        affected.add(id); changed = true;
      }
    }
  }
  names([...affected], contexts, 'exact seven reverse dependency ancestors');
  return affected;
}

function transformedManagedEntries(original: Lock, source: Lock, rename: ReadonlyMap<string, string>,
  selectedSeeds: readonly string[]): { packages: Record<string, JsonValue>; transformed: Record<string, JsonValue> } {
  const packages: Record<string, JsonValue> = { ...original.packages }, transformed: Record<string, JsonValue> = {};
  for (const [id, row] of Object.entries(original.snapshots)) {
    const pkg = original.packages[locator(id).coordinate]; need(pkg, 'transform package');
    if (rename.has(id)) { supportedBoundary(row, false, id === formatsPeer); supportedBoundary(pkg, true, id === formatsPeer); }
    const result: Record<string, JsonValue> = { ...rewritten(row, rename) };
    if (selectedSeeds.includes(id)) {result.optionalDependencies = { ...object(result.optionalDependencies ?? {}), '@types/node': '24.13.3' };}
    if (id === formatsPeer) {
      same(result.optionalDependencies, { ajv: '8.20.0' }, 'formats original optional AJV');
      need(!Object.hasOwn(result, 'dependencies'), 'formats original required section');
      for (const field of ['peerDependencies', 'peerDependenciesMeta']) {
        if (Object.hasOwn(result, field)) {same(result[field], pkg[field], 'formats snapshot peer metadata');}
        delete result[field];
      }
      delete result.optionalDependencies; result.dependencies = { ajv: '8.20.0' };
      const corrected: Record<string, JsonValue> = { ...pkg };
      delete corrected.peerDependencies; delete corrected.peerDependenciesMeta; packages[formats] = corrected;
    }
    transformed[rename.get(id) ?? id] = result;
  }
  same(packages[formats], source.packages[formats], 'formats Source package agreement');
  same(transformed[formats], source.snapshots[formats], 'formats Source snapshot agreement');
  for (const coordinate of [nodeTypes, undici]) {
    const pkg = source.packages[coordinate], row = source.snapshots[coordinate]; need(pkg && row, 'borrowed Source entries');
    names(edges(row).map(([name, version]) => edge(name, version)), coordinate === nodeTypes ? [undici] : [], 'exact borrowed reachability');
    if (coordinate === nodeTypes) {need(row.dependencies?.['undici-types'] === '7.18.2', 'required node-to-undici edge');}
    packages[coordinate] = pkg; transformed[coordinate] = row;
  }
  return { packages, transformed };
}

function derive(inputs: ParsedRestorationLockInputs) {
  const envelope = inputs.original.tree, original = lock(object(envelope.pnpmLock)), source = lock(inputs.source.tree);
  const originalAll = rooted(original), sourceAll = rooted(source);
  const rootImporter = validatedOriginalManagedImporter(envelope, original, originalAll);
  const selectedSeeds = declarations(inputs, original, source);
  const affected = reverseNodePeerAncestors(original, originalAll, selectedSeeds);
  const rename = new Map([...affected].map(id => { need(locator(id).context === '', 'preexisting node context'); return [id, id + suffix]; }));
  rename.set(formatsPeer, formats);
  names([...new Set(rename.values())], [...rename.values()], 'injective locator substitution');
  for (const destination of rename.values()) {need(!Object.hasOwn(original.snapshots, destination), 'locator collision');}
  const { packages, transformed } = transformedManagedEntries(original, source, rename, selectedSeeds);
  const sourceManaged = reach(source, managedStarts(source)), foreign = reach(source, starts(source, true));
  need(sourceManaged.size === 85 && sourceAll.size === 127, 'Source closure counts');
  const removed = [...sourceManaged].filter(id => !Object.hasOwn(transformed, id) && !foreign.has(id));
  const removedCoordinates = [...new Set(removed.map(id => locator(id).coordinate))];
  need(removed.length === 5 && removedCoordinates.length === 5, 'five superseded Source entries');
  names(removedCoordinates.map(id => locator(id).name), claims.map(id => locator(id).name), 'superseded managed identities');
  const expectedSnapshots: Record<string, JsonValue> = { ...source.snapshots };
  for (const id of removed) {delete expectedSnapshots[id];}
  Object.assign(expectedSnapshots, transformed);
  const used = new Set(Object.keys(expectedSnapshots).map(id => locator(id).coordinate));
  const expectedPackages: Record<string, JsonValue> = { ...source.packages };
  const deletedPackages = Object.keys(expectedPackages).filter(id => !used.has(id));
  names(deletedPackages, removedCoordinates, 'derived Source package deletion');
  for (const id of deletedPackages) {delete expectedPackages[id];}
  Object.assign(expectedPackages, packages);
  const foreignPackages = new Set([...foreign].map(id => locator(id).coordinate));
  for (const id of foreign) {same(expectedSnapshots[id], source.snapshots[id], 'shared/foreign snapshot preservation');}
  for (const id of foreignPackages) {same(expectedPackages[id], source.packages[id], 'shared/foreign package preservation');}
  const sourceRoot = source.importers['.']; need(sourceRoot, 'Source root');
  const devDependencies: Record<string, JsonValue> = { ...sourceRoot.devDependencies };
  for (const name of Object.keys(roots)) {
    const binding = rootImporter.devDependencies?.[name]; need(binding, 'original root binding');
    const replacement = rename.get(edge(name, binding.version));
    devDependencies[name] = { ...binding, version: replacement === undefined ? binding.version : replacement.slice(name.length + 1) };
  }
  const expected = lock({ ...source, packages: expectedPackages, snapshots: expectedSnapshots,
    importers: { ...source.importers, '.': { ...sourceRoot, devDependencies } } });
  const whole = rooted(expected), managed = reach(expected, managedStarts(expected));
  names([...managed], Object.keys(transformed), 'exact transformed managed reachability');
  const foreignOnly = [...whole].filter(id => !managed.has(id));
  need(managed.size === 85 && foreignOnly.length === 42 && whole.size === 127, '85 managed plus 42 foreign equals 127');
  const commentRename = new Map<string, string>();
  for (const id of removed) {
    const originalCoordinate = claims.find(candidate => locator(candidate).name === locator(id).name);
    need(originalCoordinate !== undefined && originalCoordinate.length > 0, 'superseded comment owner');
    commentRename.set('packages/' + locator(id).coordinate, originalCoordinate);
    commentRename.set('snapshots/' + id, rename.get(originalCoordinate) ?? originalCoordinate);
  }
  return { expected, originalCount: originalAll.size, managedCount: managed.size, foreignCount: foreignOnly.length,
    wholeCount: whole.size, contextLocators: [...affected].map(id => id + suffix).toSorted(),
    removedCoordinates: removedCoordinates.toSorted(), foreign, foreignPackages, commentRename };
}

function protectedForeign(path: Path, foreign: ReadonlySet<string>, packages: ReadonlySet<string>): boolean {
  const [section, id, group, name] = path;
  if (section === undefined) {return false;}
  if (section === 'packages') {return typeof id === 'string' && packages.has(id);}
  if (section === 'snapshots') {return typeof id === 'string' && foreign.has(id);}
  if (section !== 'importers') {return true;}
  if (id === undefined) {return false;}
  if (id !== '.') {return true;}
  if (typeof group !== 'string') {return false;}
  if (!sections.some(sectionName => sectionName === group)) {return true;}
  return typeof name === 'string' && !Object.hasOwn(roots, name);
}

/** Fixed managed-qualification helper. Actual bytes are never an expected-graph input. */
export function evaluateManagedRestorationLockV1(request: unknown): ManagedRestorationLockV1Result {
  let phase: 'input' | 'derivation' = 'input';
  try {
    exact(request, ['schemaVersion', 'selection', 'originalClosureBytes', 'sourceLockBytes', 'actualLockBytes', 'archiveBytes']);
    need(request.schemaVersion === 1, 'request version');
    const selection = request.selection;
    exact(selection, ['originalClosureSha256', 'sourceLockSha256', 'sourceLockBlob', 'archives']);
    const archivePins = selection.archives, archiveBytes = request.archiveBytes;
    exact(archivePins, covered); exact(archiveBytes, covered);
    const { originalClosureSha256, sourceLockSha256, sourceLockBlob } = selection;
    need(typeof originalClosureSha256 === 'string' && typeof sourceLockSha256 === 'string' &&
      typeof sourceLockBlob === 'string', 'selection string');
    const archives: Record<string, Uint8Array> = {};
    const pins = Object.fromEntries(covered.map(coordinate => {
      const pin = archivePins[coordinate];
      exact(pin, ['sha256', 'manifestSha256', 'manifestPath']);
      need(typeof pin.sha256 === 'string' && typeof pin.manifestSha256 === 'string' && typeof pin.manifestPath === 'string', 'archive pin strings');
      const bytes = archiveBytes[coordinate]; need(bytes instanceof Uint8Array, 'archive bytes');
      archives[coordinate] = bytes;
      return [coordinate, Object.freeze({ sha256: pin.sha256, manifestSha256: pin.manifestSha256, manifestPath: pin.manifestPath })] as const;
    }));
    const original = request.originalClosureBytes, source = request.sourceLockBytes;
    need(original instanceof Uint8Array && source instanceof Uint8Array, 'graph bytes');
    const actualBytes = request.actualLockBytes;
    need(actualBytes instanceof Uint8Array && actualBytes.byteLength <= 4 * 1024 * 1024, 'actual byte bound');
    const actual = Buffer.from(actualBytes);
    const bindings = { originalClosureSha256, sourceLockSha256, sourceLockBlob,
      actualLockSha256: createHash('sha256').update(actual).digest('hex'), archives: pins };
    const inputs = admitRestorationLockInputs({ original, source, actual, archives }, bindings);
    phase = 'derivation'; const derived = derive(inputs);
    const diagnostics: ManagedRestorationLockV1Diagnostic[] = [];
    compare(derived.expected, inputs.actual.tree, [], diagnostics, 'mismatch');
    const protect = (path: Path) => protectedForeign(path, derived.foreign, derived.foreignPackages);
    const { source: sourceAnnotations, actual: actualAnnotations } = collectRestorationLockAnnotations(
      inputs.source.bytes, inputs.actual.bytes, protect, derived.commentRename, need);
    compare(sourceAnnotations.comments, actualAnnotations.comments, ['$yaml', 'comments'], diagnostics, 'preservation');
    compare(sourceAnnotations.spelling, actualAnnotations.spelling, ['$yaml', 'foreign'], diagnostics, 'preservation');
    const expectedLockDigest: `sha256:${string}` = `sha256:${createHash('sha256')
      .update('managed-restoration-lock/v1\n').update(canonical(derived.expected)).digest('hex')}`;
    const provenance: ManagedRestorationLockV1Provenance = {
      originalClosureSha256: bindings.originalClosureSha256, originalPackageManager: 'pnpm@11.20.0',
      sourceLockSha256: bindings.sourceLockSha256, sourceLockBlob: bindings.sourceLockBlob, archives: Object.freeze(pins),
      originalSnapshotCount: derived.originalCount, managedSnapshotCount: derived.managedCount,
      foreignOnlySnapshotCount: derived.foreignCount, wholeSnapshotCount: derived.wholeCount,
      contextLocators: Object.freeze(derived.contextLocators), borrowedCoordinates: Object.freeze([nodeTypes, undici]),
      removedSourceCoordinates: Object.freeze(derived.removedCoordinates),
    };
    return diagnostics.length === 0
      ? { schemaVersion: 1, conformance: 'conformant', expectedLockDigest, provenance, diagnostics: [] }
      : { schemaVersion: 1, conformance: 'nonconformant', expectedLockDigest, provenance, diagnostics };
  } catch (cause: unknown) {
    return { schemaVersion: 1, conformance: 'nonconformant', diagnostics: [{ code: phase,
      path: cause instanceof Refusal ? cause.path : [], message: cause instanceof Error ? cause.message : 'input rejected' }] };
  }
}
