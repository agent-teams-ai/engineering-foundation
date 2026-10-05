import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { TextDecoder } from 'node:util';
import { createScanner, parseTree, type Node as JsonNode, type ParseError } from 'jsonc-parser';
import { isAlias, isMap, isScalar, isSeq, Parser, parseDocument } from 'yaml';
import type {
  ArchiveInputBinding, JsonObject, JsonValue, ParsedArchiveInput, ParsedInputDocument,
  ParsedRestorationLockInputs, RestorationInputBindings, RestorationInputBytes,
} from '../../application/model/restoration-lock-inputs.js';

const MiB = 1024 * 1024;
// Limits include every field/key; aggregate limits are independent of per-input limits.
const limits = {
  graph: 4 * MiB, graphs: 8 * MiB, archives: 32,
  compressed: 8 * MiB, allCompressed: 64 * MiB, unpacked: 32 * MiB, allUnpacked: 64 * MiB,
  members: 8192, allMembers: 32768, manifest: 512 * 1024, allManifests: 4 * MiB,
  depth: 64, nodes: 100_000, allNodes: 500_000, string: 256 * 1024,
};
const coreTags = new Set(['null', 'bool', 'int', 'float', 'str', 'seq', 'map'].map(name => 'tag:yaml.org,2002:' + name));
const borrowed = new Set(['@types/node@24.13.3', 'undici-types@7.18.2']);
interface Budget { nodes: number; unpacked: number; members: number; manifests: number; }
interface TreeBudget { nodes: number; shared: Budget; }

function insist(value: unknown, message: string): asserts value {
  const accepted = Boolean(value);
  if (!accepted) {throw new Error('restoration inputs: ' + message);}
}
function isList(value: JsonValue | undefined): value is readonly JsonValue[] { return Array.isArray(value); }
function record(value: JsonValue | undefined): JsonObject {
  insist(value !== null && typeof value === 'object' && !isList(value), 'object');
  return value;
}
function atomic(value: unknown): JsonValue {
  insist(value === null || typeof value === 'string' || typeof value === 'boolean' ||
    typeof value === 'number' && Number.isFinite(value), 'JSON scalar');
  return value;
}
function account(b: TreeBudget, depth: number, value?: unknown): void {
  insist(depth <= limits.depth && ++b.nodes <= limits.nodes && ++b.shared.nodes <= limits.allNodes, 'tree bound');
  if (typeof value === 'string') {insist(value.length <= limits.string, 'string bound');}
}

function jsonSyntax(text: string): void {
  const scanner = createScanner(text, true);
  let depth = 0, lexemes = 0;
  for (;;) {
    scanner.scan();
    const offset = scanner.getTokenOffset(), length = scanner.getTokenLength();
    if (length === 0 && offset === text.length) {break;}
    insist(++lexemes <= limits.nodes * 6, 'JSON syntax bound');
    const raw = text.slice(offset, offset + length);
    if (raw === '{' || raw === '[') {depth++;}
    if (raw === '}' || raw === ']') {depth--;}
    insist(depth <= limits.depth, 'depth bound');
    if (raw.startsWith('"')) {insist(scanner.getTokenValue().length <= limits.string, 'string bound');}
  }
}
function jsonNode(node: JsonNode, b: TreeBudget, depth: number): JsonValue {
  account(b, depth, node.value);
  if (node.type === 'array') {return Object.freeze((node.children ?? []).map(child => jsonNode(child, b, depth + 1)));}
  if (node.type !== 'object') {return atomic(node.value);}
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const property of node.children ?? []) {
    const [key, value] = property.children ?? [];
    insist(key?.type === 'string' && typeof key.value === 'string' && value, 'JSON property');
    account(b, depth + 1, key.value);
    insist(!Object.hasOwn(result, key.value), 'duplicate JSON key');
    result[key.value] = jsonNode(value, b, depth + 1);
  }
  return Object.freeze(result);
}
function parseJson(text: string, shared: Budget): JsonObject {
  jsonSyntax(text);
  const errors: ParseError[] = [];
  const node = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  insist(node && errors.length === 0, 'JSON syntax');
  return record(jsonNode(node, { nodes: 0, shared }, 0));
}

function yamlSyntax(text: string): void {
  let nodes = 0;
  for (const token of new Parser().parse(text)) {
    const stack: { value: object; depth: number }[] = [{ value: token, depth: 0 }];
    while (stack.length) {
      const item = stack.pop(); insist(item, 'YAML syntax');
      insist(item.depth <= limits.depth * 3 && ++nodes <= limits.allNodes, 'YAML syntax bound');
      const values: readonly unknown[] = Object.values(item.value);
      for (const value of values) {
        if (value !== null && typeof value === 'object') {stack.push({ value, depth: item.depth + 1 });}
      }
    }
  }
}
function yamlNode(node: unknown, b: TreeBudget, depth: number): JsonValue {
  account(b, depth, isScalar(node) ? node.value : undefined);
  if (node === null || node === undefined) {return null;}
  insist(!isAlias(node), 'YAML alias');
  insist(isMap(node) || isSeq(node) || isScalar(node), 'YAML value');
  insist(node.tag === undefined || coreTags.has(node.tag), 'YAML tag');
  if (isScalar(node)) {return atomic(node.value);}
  if (isSeq(node)) {return Object.freeze(node.items.map(item => yamlNode(item, b, depth + 1)));}
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const pair of node.items) {
    insist(isScalar(pair.key) && typeof pair.key.value === 'string', 'YAML key');
    const key = yamlNode(pair.key, b, depth + 1);
    insist(typeof key === 'string' && !Object.hasOwn(result, key), 'duplicate YAML key');
    result[key] = yamlNode(pair.value, b, depth + 1);
  }
  return Object.freeze(result);
}
function parseYaml(text: string, shared: Budget): JsonObject {
  yamlSyntax(text);
  const doc = parseDocument(text, { schema: 'core', version: '1.2', strict: true, uniqueKeys: true, prettyErrors: false });
  insist(doc.errors.length === 0 && doc.warnings.length === 0, 'YAML syntax');
  insist(doc.directives.yaml.version === '1.2', 'YAML version');
  return record(yamlNode(doc.contents, { nodes: 0, shared }, 0));
}

function sha256(bytes: Buffer, expected: string): void {
  insist(typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected), 'sha256 binding format');
  insist(createHash('sha256').update(bytes).digest('hex') === expected, 'sha256 mismatch');
}
function utf8(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
function document(bytes: Buffer, tree: JsonObject): ParsedInputDocument {
  return Object.freeze({ bytes: Object.freeze(Array.from(bytes)), tree });
}
function copyInputs(input: RestorationInputBytes) {
  const graphs = [input.original, input.source, input.actual];
  insist(graphs.every(bytes => bytes instanceof Uint8Array && bytes.byteLength <= limits.graph), 'graph byte bound');
  insist(graphs.reduce((sum, bytes) => sum + bytes.byteLength, 0) <= limits.graphs, 'global graph byte bound');
  const keys = Object.keys(input.archives);
  insist(keys.length <= limits.archives, 'archive count bound');
  const archives: Record<string, Buffer> = Object.create(null) as Record<string, Buffer>;
  let compressed = 0;
  for (const coordinate of keys) {
    const bytes = input.archives[coordinate]; insist(bytes instanceof Uint8Array, 'archive bytes');
    insist(bytes.byteLength <= limits.compressed, 'compressed byte bound');
    insist((compressed += bytes.byteLength) <= limits.allCompressed, 'global compressed byte bound');
    archives[coordinate] = Buffer.from(bytes);
  }
  return { original: Buffer.from(input.original), source: Buffer.from(input.source), actual: Buffer.from(input.actual), archives };
}

function envelope(o: JsonObject): Readonly<Record<string, string>> {
  insist(o.domain === 'agent-teams.docs-runtime-closure/v2' && o.schemaVersion === 2, 'original envelope');
  insist(o.packageManager === 'pnpm@11.20.0', 'original package manager');
  insist(isList(o.coordinates), 'original coordinates');
  insist(Object.hasOwn(o, 'managedEdges'), 'original managed edges');
  const lock = record(o.pnpmLock), packages = record(lock.packages), snapshots = record(lock.snapshots);
  insist(typeof o.packageCount === 'number' && Number.isSafeInteger(o.packageCount) &&
    o.packageCount === Object.keys(snapshots).length && o.packageCount === Object.keys(packages).length, 'original package count');
  const claims: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const value of o.coordinates) {
    const row = record(value);
    insist(typeof row.name === 'string' && typeof row.version === 'string' && typeof row.integrity === 'string' && (row.role === 'direct' || row.role === 'transitive'), 'coordinate fields');
    const coordinate = `${row.name}@${row.version}`;
    insist(!Object.hasOwn(claims, coordinate), 'duplicate coordinate');
    insist(lookup(packages, coordinate) === row.integrity, 'coordinate integrity disagreement');
    claims[coordinate] = row.integrity;
  }
  return claims;
}
function lookup(packages: JsonObject, coordinate: string): string | undefined {
  if (!Object.hasOwn(packages, coordinate)) {return undefined;}
  const resolution = record(record(packages[coordinate]).resolution);
  insist(typeof resolution.integrity === 'string', 'resolution integrity');
  return resolution.integrity;
}
function expectedIntegrity(o: JsonObject, s: JsonObject, claims: Readonly<Record<string, string>>, key: string): string {
  const original = lookup(record(record(o.pnpmLock).packages), key);
  const source = lookup(record(s.packages), key);
  const selected = borrowed.has(key) ? source : original;
  insist(selected !== undefined, 'missing provenance resolution');
  for (const claim of [original, source, claims[key]]) {insist(claim === undefined || claim === selected, 'integrity disagreement');}
  return selected;
}
function authenticateSRI(archive: Buffer, integrity: string): void {
  insist(/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity), 'SRI format');
  const encoded = integrity.slice(7);
  const expected = Buffer.from(encoded, 'base64');
  insist(expected.length === 64 && expected.toString('base64') === encoded, 'SRI encoding');
  insist(createHash('sha512').update(archive).digest().equals(expected), 'SRI mismatch');
}

function octal(field: Buffer): number {
  insist((field[0] ?? 0) < 128, 'base256 tar number');
  const text = field.toString('latin1');
  insist(/^ *[0-7]*[\0 ]*$/.test(text), 'tar octal');
  const clean = text.replaceAll('\0', ' ').trim();
  const value = clean === '' ? 0 : Number.parseInt(clean, 8);
  insist(Number.isSafeInteger(value), 'tar integer');
  return value;
}
function tarString(field: Buffer): string {
  const end = field.indexOf(0);
  if (end >= 0) {insist(field.subarray(end).every(byte => byte === 0), 'tar string padding');}
  return utf8(end < 0 ? field : field.subarray(0, end));
}
function tarPrefix(header: Buffer): string {
  const prefixField = header.subarray(345, 500);
  const extendedPrefix = prefixField.subarray(0, 131);
  let prefix: string;
  if (extendedPrefix.includes(0) && prefixField.subarray(131).some(byte => byte !== 0)) {
    // Recognize the observed ustar/star-layout extension: a NUL-terminated
    // 131-byte prefix followed by canonical octal atime and ctime fields.
    // Every prefix-padding byte remains checked by tarString.
    prefix = tarString(extendedPrefix);
    for (const offset of [476, 488]) {
      const field = header.subarray(offset, offset + 12);
      octal(field);
      insist(/^[0-7]{11}\0$/.test(field.toString('latin1')), 'tar extended time');
    }
  } else {
    prefix = tarString(prefixField);
  }
  return prefix;
}

function tarHeader(header: Buffer): { name: string; size: number; kind: string } {
  const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
  insist(octal(header.subarray(148, 156)) === checksum, 'tar checksum');
  insist(header.subarray(257, 263).equals(Buffer.from('ustar\0')) && header.subarray(263, 265).equals(Buffer.from('00')), 'tar dialect');
  for (const [offset, length] of [[100, 8], [108, 8], [116, 8], [136, 12], [329, 8], [337, 8]] as const) {octal(header.subarray(offset, offset + length));}
  const size = octal(header.subarray(124, 136));
  const kind = header[156] === 0 ? '0' : String.fromCharCode(header[156] ?? 0);
  insist(kind === '0' || kind === '5', 'tar member type');
  insist(header.subarray(157, 257).every(byte => byte === 0), 'tar link');
  const prefix = tarPrefix(header);
  let name = (prefix ? prefix + '/' : '') + tarString(header.subarray(0, 100));
  if (kind === '5' && name.endsWith('/')) {name = name.slice(0, -1);}
  insist(!name.includes('\\') && name.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'tar path');
  return { name, size, kind };
}
function tarManifest(compressed: Buffer, path: string, shared: Budget): Buffer {
  const data = gunzipSync(compressed, { maxOutputLength: limits.unpacked });
  insist((shared.unpacked += data.length) <= limits.allUnpacked, 'global unpacked byte bound');
  insist(data.length % 512 === 0, 'tar alignment');
  const root = path.slice(0, path.indexOf('/'));
  const seen = new Set<string>(); let manifest: Buffer | undefined; let offset = 0; let members = 0;
  while (offset < data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      insist(data.length - offset >= 1024 && data.subarray(offset).every(byte => byte === 0), 'tar end');
      insist(manifest, 'missing manifest'); return manifest;
    }
    insist(++members <= limits.members && ++shared.members <= limits.allMembers, 'tar member bound');
    const { name, size, kind } = tarHeader(header);
    insist(name === root && kind === '5' || name.startsWith(root + '/'), 'archive root');
    insist(!seen.has(name), 'duplicate tar name'); seen.add(name);
    offset += 512;
    const padded = Math.ceil(size / 512) * 512;
    insist(padded <= data.length - offset, 'tar size');
    if (kind === '5') {insist(size === 0, 'directory size');}
    if (name === path) {
      insist(kind === '0', 'manifest regular');
      insist(size <= limits.manifest && (shared.manifests += size) <= limits.allManifests, 'manifest byte bound');
      manifest = Buffer.from(data.subarray(offset, offset + size));
    }
    insist(data.subarray(offset + size, offset + padded).every(byte => byte === 0), 'tar padding');
    offset += padded;
  }
  throw new Error('restoration inputs: missing tar end');
}

function archiveInput(compressed: Buffer, pin: ArchiveInputBinding, expectation: { coordinate: string; integrity: string }, shared: Budget) {
  const { coordinate, integrity } = expectation;
  const path = coordinate === '@types/node@24.13.3' ? 'node v24.13/package.json' : 'package/package.json';
  insist(pin.manifestPath === path, 'manifest path binding');
  sha256(compressed, pin.sha256); authenticateSRI(compressed, integrity);
  const bytes = tarManifest(compressed, path, shared);
  sha256(bytes, pin.manifestSha256);
  const manifest = parseJson(utf8(bytes), shared);
  insist(typeof manifest.name === 'string' && typeof manifest.version === 'string' && `${manifest.name}@${manifest.version}` === coordinate, 'manifest coordinate');
  return Object.freeze({ coordinate, integrity, compressedSha256: pin.sha256, manifestBytes: Object.freeze(Array.from(bytes)), manifest });
}

/** Internal byte admission only; no restoration receipt or whole-lock conformance. */
export function admitRestorationLockInputs(input: RestorationInputBytes, bindings: RestorationInputBindings): ParsedRestorationLockInputs {
  const bytes = copyInputs(input);
  const keys = Object.keys(bytes.archives), pins = Object.keys(bindings.archives);
  insist(keys.length === pins.length && keys.every(key => Object.hasOwn(bindings.archives, key)), 'archive binding keys');
  sha256(bytes.original, bindings.originalClosureSha256);
  sha256(bytes.source, bindings.sourceLockSha256);
  sha256(bytes.actual, bindings.actualLockSha256);
  insist(/^[a-f0-9]{40}$/.test(bindings.sourceLockBlob), 'source blob format');
  const blob = createHash('sha1').update(`blob ${bytes.source.length}\0`).update(bytes.source).digest('hex');
  insist(blob === bindings.sourceLockBlob, 'source blob mismatch');
  const shared: Budget = { nodes: 0, unpacked: 0, members: 0, manifests: 0 };
  const o = parseJson(utf8(bytes.original), shared), s = parseYaml(utf8(bytes.source), shared), a = parseYaml(utf8(bytes.actual), shared);
  const claims = envelope(o);
  const archives: Record<string, ParsedArchiveInput> = Object.create(null) as Record<string, ParsedArchiveInput>;
  for (const coordinate of keys) {
    const compressed = bytes.archives[coordinate], pin = bindings.archives[coordinate];
    insist(compressed && pin, 'archive binding');
    archives[coordinate] = archiveInput(compressed, pin, { coordinate, integrity: expectedIntegrity(o, s, claims, coordinate) }, shared);
  }
  return Object.freeze({ original: document(bytes.original, o), source: document(bytes.source, s), actual: document(bytes.actual, a), archives: Object.freeze(archives) });
}
