/** Pure CI input comparison. Completeness, classification and authority belong to the Host. */
export type DigestScheme = 'git-object-sha1' | 'sha256';
export type InputLeaf = Readonly<{
  path: string;
  type: 'file' | 'symlink' | 'gitlink';
  mode: '100644' | '100755' | '120000' | '160000';
  membership: 'closed' | 'structural';
  content: string;
}>;
export type LeafInventory = Readonly<{
  version: 1;
  digestScheme: DigestScheme;
  inputs: readonly InputLeaf[];
}>;
export type RejectionReason =
  | 'malformed-inventory' | 'unsupported-version' | 'unsupported-scheme'
  | 'scheme-mismatch' | 'duplicate-input' | 'incomplete-inputs'
  | 'invalid-content-permission' | 'input-structure-changed'
  | 'closed-input-changed' | 'exceeded-limit';
export type ComparisonResult =
  | Readonly<{ status: 'compatible-inputs'; changedContentPaths: readonly string[] }>
  | Readonly<{ status: 'rejected'; reason: RejectionReason }>;

type Rejected = Extract<ComparisonResult, { status: 'rejected' }>;
type Parsed<T> = Readonly<{ status: 'parsed'; value: T }> | Rejected;
const maxLeaves = 65_536;
const maxPathLength = 4096;
const reject = (reason: RejectionReason): Rejected => Object.freeze({ status: 'rejected', reason });
const parsed = <T>(value: T): Parsed<T> => ({ status: 'parsed', value });

// Inspect original descriptors before reading values. Executable Proxies and
// modified JS intrinsics are outside this inert-input contract.
function ownRecord(value: unknown, keys: readonly string[]): Map<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) { return undefined; }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) { return undefined; }
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.length !== keys.length) { return undefined; }
  const fields = new Map<string, unknown>();
  for (const key of actualKeys) {
    if (typeof key !== 'string' || !keys.includes(key)) { return undefined; }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) { return undefined; }
    const field: unknown = descriptor.value;
    fields.set(key, field);
  }
  return fields;
}

function denseArray(value: unknown, limit: number, malformed: RejectionReason): Parsed<unknown[]> {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) { return reject(malformed); }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length: unknown = lengthDescriptor?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) { return reject(malformed); }
  // A count violation rejects before enumerating or copying indexed elements.
  if (length > limit) { return reject('exceeded-limit'); }
  if (Reflect.ownKeys(value).length !== length + 1) { return reject(malformed); }
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) { return reject(malformed); }
    const item: unknown = descriptor.value;
    values.push(item);
  }
  return parsed(values);
}

function forbiddenPathCharacter(path: string): boolean {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 32 || code === 127 || code === 92) { return true; }
  }
  return false;
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxPathLength
    && !forbiddenPathCharacter(value)
    && !/^[A-Za-z]:/u.test(value)
    && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

function parseLeaf(value: unknown, scheme: DigestScheme): Parsed<InputLeaf> {
  const fields = ownRecord(value, ['path', 'type', 'mode', 'membership', 'content']);
  if (fields === undefined) { return reject('malformed-inventory'); }
  const path = fields.get('path');
  if (typeof path === 'string' && path.length > maxPathLength) { return reject('exceeded-limit'); }
  const type = fields.get('type');
  const mode = fields.get('mode');
  const membership = fields.get('membership');
  const content = fields.get('content');
  if (!validPath(path) || (membership !== 'closed' && membership !== 'structural')
      || typeof content !== 'string') { return reject('malformed-inventory'); }
  const digest = scheme === 'git-object-sha1' ? /^[0-9a-f]{40}$/u : /^[0-9a-f]{64}$/u;
  if (!digest.test(content) || /^0+$/u.test(content)) { return reject('malformed-inventory'); }
  if (type === 'file' && (mode === '100644' || mode === '100755')) {
    return parsed({ path, type, mode, membership, content });
  }
  if (type === 'symlink' && mode === '120000') { return parsed({ path, type, mode, membership, content }); }
  if (type === 'gitlink' && mode === '160000') { return parsed({ path, type, mode, membership, content }); }
  return reject('malformed-inventory');
}

type InventoryFacts = Readonly<{ scheme: DigestScheme; leaves: ReadonlyMap<string, InputLeaf> }>;
function parseInventory(value: unknown): Parsed<InventoryFacts> {
  const fields = ownRecord(value, ['version', 'digestScheme', 'inputs']);
  if (fields === undefined) { return reject('malformed-inventory'); }
  if (fields.get('version') !== 1) { return reject('unsupported-version'); }
  const scheme = fields.get('digestScheme');
  if (scheme !== 'sha256' && scheme !== 'git-object-sha1') { return reject('unsupported-scheme'); }
  const array = denseArray(fields.get('inputs'), maxLeaves, 'malformed-inventory');
  if (array.status === 'rejected') { return array; }
  const leaves = new Map<string, InputLeaf>();
  let hasClosed = false;
  for (const entry of array.value) {
    const leaf = parseLeaf(entry, scheme);
    if (leaf.status === 'rejected') { return leaf; }
    if (leaves.has(leaf.value.path)) { return reject('duplicate-input'); }
    leaves.set(leaf.value.path, leaf.value);
    hasClosed ||= leaf.value.membership === 'closed';
  }
  if (!hasClosed) { return reject('incomplete-inputs'); }
  return parsed({ scheme, leaves });
}

function parsePermissions(value: unknown, leaves: ReadonlyMap<string, InputLeaf>): Parsed<ReadonlySet<string>> {
  const array = denseArray(value, leaves.size, 'invalid-content-permission');
  if (array.status === 'rejected') { return array; }
  const permissions = new Set<string>();
  for (const path of array.value) {
    if (!validPath(path) || permissions.has(path) || leaves.get(path)?.membership !== 'structural') {
      return reject('invalid-content-permission');
    }
    permissions.add(path);
  }
  return parsed(permissions);
}

/**
 * Compare bounded inert inventories without I/O or input mutation. A compatible
 * relation is neither a completeness proof nor permission to omit checks/merge.
 * Failures validate before, after, scheme, permissions, structure, then content.
 */
export function compareLeafInventories(
  before: unknown, after: unknown, permittedContentChanges: unknown,
): ComparisonResult {
  const previous = parseInventory(before);
  if (previous.status === 'rejected') { return previous; }
  const current = parseInventory(after);
  if (current.status === 'rejected') { return current; }
  if (previous.value.scheme !== current.value.scheme) { return reject('scheme-mismatch'); }
  const permissions = parsePermissions(permittedContentChanges, previous.value.leaves);
  if (permissions.status === 'rejected') { return permissions; }
  const oldLeaves = previous.value.leaves;
  const newLeaves = current.value.leaves;
  if (oldLeaves.size !== newLeaves.size) { return reject('input-structure-changed'); }
  for (const [path, leaf] of oldLeaves) {
    const next = newLeaves.get(path);
    if (next === undefined || next.type !== leaf.type || next.mode !== leaf.mode || next.membership !== leaf.membership) {
      return reject('input-structure-changed');
    }
  }
  const changed: string[] = [];
  for (const [path, leaf] of oldLeaves) {
    const next = newLeaves.get(path);
    if (next !== undefined && next.content !== leaf.content) {
      if (leaf.membership === 'closed' || !permissions.value.has(path)) { return reject('closed-input-changed'); }
      changed.push(path);
    }
  }
  return Object.freeze({ status: 'compatible-inputs', changedContentPaths: Object.freeze(changed.toSorted()) });
}
