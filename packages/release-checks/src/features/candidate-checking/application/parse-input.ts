import type { Json, JsonRecord, ReleaseCandidateInput } from './model.js';

function invalid(path: string): never { throw new Error(`Invalid release candidate input at ${path}.`); }

interface JsonBudget { nodes: number; characters: number; readonly ancestors: Set<object> }
function jsonArray(value: unknown[], keyCount: number, path: string, depth: number, budget: JsonBudget): Json {
  if (value.length > 65_536 || keyCount !== value.length + 1) { invalid(path); }
  const result: Json[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) { invalid(path); }
    const item: unknown = descriptor.value;
    result.push(json(item, `${path}[${i}]`, depth + 1, budget));
  }
  return result;
}
function jsonObject(value: object, keys: readonly PropertyKey[], path: string, depth: number, budget: JsonBudget): Json {
  const result: Record<string, Json> = Object.create(null) as Record<string, Json>;
  for (const key of keys) {
    if (typeof key !== 'string') { invalid(path); }
    budget.characters -= key.length;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable || budget.characters < 0) { invalid(path); }
    const item: unknown = descriptor.value;
    result[key] = json(item, `${path}.${key}`, depth + 1, budget);
  }
  return result;
}
/** Copy bounded ordinary JSON; executable Proxies and modified intrinsics are outside this contract. */
function json(value: unknown, path: string, depth: number, budget: JsonBudget): Json {
  budget.nodes -= 1;
  if (budget.nodes < 0 || depth > 64) { invalid(path); }
  if (value === null || typeof value === 'boolean') { return value; }
  if (typeof value === 'number') { if (!Number.isFinite(value)) { invalid(path); } return value; }
  if (typeof value === 'string') {
    budget.characters -= value.length;
    if (budget.characters < 0) { invalid(path); }
    return value;
  }
  if (typeof value !== 'object' || budget.ancestors.has(value)) { invalid(path); }
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) { invalid(path); }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 65_537 || keys.some(key => typeof key !== 'string')) { invalid(path); }
  budget.ancestors.add(value);
  const result = array ? jsonArray(value, keys.length, path, depth, budget) : jsonObject(value, keys, path, depth, budget);
  budget.ancestors.delete(value);
  return result;
}

function object(value: Json | undefined, path: string, keys?: readonly string[]): JsonRecord {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) { invalid(path); }
  const result = value as JsonRecord;
  if (keys !== undefined && (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key)))) { invalid(path); }
  return result;
}
function list(value: Json | undefined, path: string): readonly Json[] {
  if (!Array.isArray(value)) { invalid(path); }
  return value as readonly Json[];
}
function text(value: Json | undefined, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) { invalid(path); }
  return value;
}
function choice(value: Json | undefined, choices: readonly string[], path: string): void {
  if (!choices.includes(text(value, path))) { invalid(path); }
}
function digest(value: Json | undefined, path: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(text(value, path))) { invalid(path); }
}
function filePath(value: Json | undefined, path: string, root = false): string {
  const result = text(value, path);
  if (root && result === '.') { return result; }
  for (let i = 0; i < result.length; i += 1) {
    const code = result.charCodeAt(i);
    if (code < 32 || code === 127 || code === 92) { invalid(path); }
  }
  if (/^[A-Za-z]:/u.test(result)
    || result.split('/').some(part => part === '' || part === '.' || part === '..')) { invalid(path); }
  return result;
}
function leaf(value: Json | undefined, path: string, withDigest: boolean, nullable: boolean): void {
  if (nullable && value === null) { return; }
  const fields = object(value, path, withDigest ? ['type', 'mode', 'digest'] : ['type', 'mode']);
  const valid = fields['type'] === 'file' ? ['100644', '100755'].includes(text(fields['mode'], path))
    : fields['type'] === 'symlink' ? fields['mode'] === '120000'
      : fields['type'] === 'gitlink' && fields['mode'] === '160000';
  if (!valid) { invalid(path); }
  if (withDigest) { digest(fields['digest'], `${path}.digest`); }
}
function manifest(value: Json | undefined, path: string, nullable: boolean): void {
  if (nullable && value === null) { return; }
  const fields = object(value, path, ['file', 'semantic']);
  leaf(fields['file'], `${path}.file`, true, false);
  const semantic = object(fields['semantic'], `${path}.semantic`);
  if (Object.hasOwn(semantic, 'version')) { text(semantic['version'], `${path}.semantic.version`); }
  if (Object.hasOwn(semantic, 'private') && typeof semantic['private'] !== 'boolean') { invalid(`${path}.semantic.private`); }
}
function binding(value: Json | undefined, path: string): void {
  const fields = object(value, path, ['source', 'engine', 'configDigest', 'inventoryDigest', 'policyDigest', 'intentsDigest', 'planDigest']);
  const source = object(fields['source'], `${path}.source`, ['repository', 'identity', 'digest']);
  text(source['repository'], `${path}.source.repository`); text(source['identity'], `${path}.source.identity`); digest(source['digest'], `${path}.source.digest`);
  const engine = object(fields['engine'], `${path}.engine`, ['name', 'version', 'digest']);
  text(engine['name'], `${path}.engine.name`); text(engine['version'], `${path}.engine.version`); digest(engine['digest'], `${path}.engine.digest`);
  for (const key of ['configDigest', 'inventoryDigest', 'policyDigest', 'intentsDigest', 'planDigest']) { digest(fields[key], `${path}.${key}`); }
}
function effect(value: Json | undefined, path: string): void {
  const fields = object(value, path);
  if (fields['kind'] === 'remove') { object(value, path, ['kind']); }
  else { object(value, path, ['kind', 'evidencePath']); choice(fields['kind'], ['record'], `${path}.kind`); filePath(fields['evidencePath'], `${path}.evidencePath`); }
}
function changes(value: Json | undefined, path: string, observed: boolean): void {
  for (const [i, item] of list(value, path).entries()) {
    const at = `${path}[${i}]`;
    const fields = object(item, at, observed ? ['path', 'classification', 'kind', 'before', 'after'] : ['path', 'classification', 'kind', 'before', 'after', 'contentAuthority']);
    filePath(fields['path'], `${at}.path`); text(fields['classification'], `${at}.classification`);
    choice(fields['kind'], ['added', 'modified', 'deleted'], `${at}.kind`);
    leaf(fields['before'], `${at}.before`, observed, true); leaf(fields['after'], `${at}.after`, observed, true);
    if (!observed) { text(fields['contentAuthority'], `${at}.contentAuthority`); }
  }
}

function validate(value: Json): void {
  const root = object(value, '$', ['schemaVersion', 'expected', 'observed']);
  if (root['schemaVersion'] !== 1) { invalid('$.schemaVersion'); }
  const expected = object(root['expected'], '$.expected', ['binding', 'packages', 'intents', 'plan', 'permittedChanges']);
  binding(expected['binding'], '$.expected.binding');
  for (const [i, item] of list(expected['packages'], '$.expected.packages').entries()) {
    const at = `$.expected.packages[${i}]`;
    const fields = object(item, at, ['name', 'root', 'manifestPath', 'classification', 'versioning', 'before']);
    text(fields['name'], `${at}.name`); filePath(fields['root'], `${at}.root`, true); filePath(fields['manifestPath'], `${at}.manifestPath`);
    choice(fields['classification'], ['public', 'private'], `${at}.classification`); choice(fields['versioning'], ['versioned', 'unversioned', 'ignored'], `${at}.versioning`);
    manifest(fields['before'], `${at}.before`, false);
  }
  for (const [i, item] of list(expected['intents'], '$.expected.intents').entries()) {
    const at = `$.expected.intents[${i}]`;
    const fields = object(item, at, ['id', 'path', 'digest', 'participation', 'requests']);
    text(fields['id'], `${at}.id`); filePath(fields['path'], `${at}.path`); digest(fields['digest'], `${at}.digest`);
    choice(fields['participation'], ['pending', 'retained'], `${at}.participation`);
    for (const request of list(fields['requests'], `${at}.requests`)) {
      const entry = object(request, `${at}.requests`, ['packageName', 'type']);
      text(entry['packageName'], `${at}.requests.packageName`); choice(entry['type'], ['major', 'minor', 'patch'], `${at}.requests.type`);
    }
  }
  const plan = object(expected['plan'], '$.expected.plan', ['releases', 'consumptions']);
  for (const [i, item] of list(plan['releases'], '$.expected.plan.releases').entries()) {
    const at = `$.expected.plan.releases[${i}]`;
    const fields = object(item, at, ['packageName', 'manifestPath', 'type', 'oldVersion', 'newVersion', 'intentIds']);
    text(fields['packageName'], `${at}.packageName`); filePath(fields['manifestPath'], `${at}.manifestPath`);
    choice(fields['type'], ['major', 'minor', 'patch', 'none'], `${at}.type`);
    for (const key of ['oldVersion', 'newVersion']) { if (fields[key] !== null) { text(fields[key], `${at}.${key}`); } }
    for (const id of list(fields['intentIds'], `${at}.intentIds`)) { text(id, `${at}.intentIds`); }
  }
  for (const [i, item] of list(plan['consumptions'], '$.expected.plan.consumptions').entries()) {
    const at = `$.expected.plan.consumptions[${i}]`;
    const fields = object(item, at, ['intentId', 'effect']); text(fields['intentId'], `${at}.intentId`); effect(fields['effect'], `${at}.effect`);
  }
  changes(expected['permittedChanges'], '$.expected.permittedChanges', false);
  const observed = object(root['observed'], '$.observed', ['binding', 'candidateIdentity', 'manifests', 'consumptions', 'diff']);
  binding(observed['binding'], '$.observed.binding'); text(observed['candidateIdentity'], '$.observed.candidateIdentity');
  for (const [i, item] of list(observed['manifests'], '$.observed.manifests').entries()) {
    const at = `$.observed.manifests[${i}]`;
    const fields = object(item, at, ['manifestPath', 'before', 'after']); filePath(fields['manifestPath'], `${at}.manifestPath`);
    manifest(fields['before'], `${at}.before`, true); manifest(fields['after'], `${at}.after`, true);
  }
  for (const [i, item] of list(observed['consumptions'], '$.observed.consumptions').entries()) {
    const at = `$.observed.consumptions[${i}]`;
    const fields = object(item, at, ['intentId', 'digest', 'effect']); text(fields['intentId'], `${at}.intentId`); digest(fields['digest'], `${at}.digest`); effect(fields['effect'], `${at}.effect`);
  }
  changes(observed['diff'], '$.observed.diff', true);
}

export function parseInput(input: unknown): Readonly<{ value: ReleaseCandidateInput }> | Readonly<{ error: string }> {
  try {
    const value = json(input, '$', 0, { nodes: 262_144, characters: 8_388_608, ancestors: new Set() });
    validate(value);
    return { value: value as unknown as ReleaseCandidateInput };
  } catch (error) { return { error: error instanceof Error ? error.message : 'Invalid release candidate input.' }; }
}
