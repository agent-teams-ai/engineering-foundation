import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isMap, parseDocument, type Document } from 'yaml';
import {
  checkManagedRestorationLockV1,
  type ManagedRestorationArchiveBindingV1,
  type ManagedRestorationLockV1Request,
  type ManagedRestorationLockV1Result,
} from '../../../packages/docs-protocol-agent-teams/dist/qualification/index.js';

interface Fixture {
  readonly schemaVersion: 1;
  readonly original: { readonly file: string; readonly sha256: string };
  readonly source: { readonly file: string; readonly sha256: string; readonly gitBlob: string };
  readonly actual: { readonly file: string; readonly sha256: string };
  readonly archives: readonly (ManagedRestorationArchiveBindingV1 & {
    readonly coordinate: string; readonly file: string; readonly integrity: string;
  })[];
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function assertFixture(value: unknown): asserts value is Fixture {
  assert.ok(record(value)); assert.equal(value.schemaVersion, 1);
  for (const field of ['original', 'source', 'actual']) {
    const row = value[field]; assert.ok(record(row));
    assert.ok(typeof row.file === 'string' && typeof row.sha256 === 'string');
    if (field === 'source') {assert.ok(typeof row.gitBlob === 'string');}
  }
  assert.ok(Array.isArray(value.archives)); assert.equal(value.archives.length, 12);
  for (const row of value.archives) {
    assert.ok(record(row));
    for (const field of ['coordinate', 'file', 'integrity', 'sha256', 'manifestSha256', 'manifestPath'])
      {assert.ok(typeof row[field] === 'string');}
  }
}
function digest(bytes: Readonly<Uint8Array>): string { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) {return '[' + value.map((item: unknown) => canonical(item)).join(',') + ']';}
  if (record(value)) {return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';}
  assert.ok(value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value));
  const encoded = JSON.stringify(value); assert.ok(typeof encoded === 'string'); return encoded;
}
async function retained(): Promise<ManagedRestorationLockV1Request> {
  const root = new URL('../../../packages/docs-protocol-agent-teams/tests/fixtures/restoration-lock-v1/', import.meta.url);
  const fixture: unknown = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assertFixture(fixture);
  assert.equal(fixture.original.sha256, '87cb5e3495848f453c1ac0e4dc8caa7d66828f0cab270cefd46d73dee2ea341a');
  assert.equal(fixture.source.sha256, '83a30e0d504b90ded54cfbf1b1c7a7bcdd4d78950876cf0d7dd352983c628916');
  assert.equal(fixture.source.gitBlob, '56b39f74f7c0e4e311b970aea1ea719caac61358');
  assert.equal(fixture.actual.sha256, 'd35092ff74098bfdf9a95cb9a5534ff7ee0aa828e9a5eba9e4114baf167c3332');
  const [original, source, actual] = await Promise.all([fixture.original, fixture.source, fixture.actual].map(row => readFile(new URL(row.file, root))));
  assert.ok(original && source && actual); assert.equal(digest(actual), fixture.actual.sha256);
  const archives = await Promise.all(fixture.archives.map(async row => [row.coordinate, await readFile(new URL(row.file, root))] as const));
  return { schemaVersion: 1, originalClosureBytes: original, sourceLockBytes: source, actualLockBytes: actual,
    archiveBytes: Object.fromEntries(archives), selection: {
      originalClosureSha256: fixture.original.sha256, sourceLockSha256: fixture.source.sha256,
      sourceLockBlob: fixture.source.gitBlob, archives: Object.fromEntries(fixture.archives.map(row => [row.coordinate,
        { sha256: row.sha256, manifestSha256: row.manifestSha256, manifestPath: row.manifestPath }])),
    } };
}
function editActual(request: ManagedRestorationLockV1Request, edit: (document: Document) => void): ManagedRestorationLockV1Request {
  const document = parseDocument(Buffer.from(request.actualLockBytes).toString('utf8'));
  edit(document); return { ...request, actualLockBytes: Buffer.from(document.toString()) };
}
function withSource(request: ManagedRestorationLockV1Request, source: Buffer): ManagedRestorationLockV1Request {
  return { ...request, sourceLockBytes: source, selection: { ...request.selection,
    sourceLockSha256: digest(source), sourceLockBlob: createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex') } };
}
function accepted(result: ManagedRestorationLockV1Result) {
  assert.equal(result.conformance, 'conformant', JSON.stringify(result.diagnostics));
  assert.ok(result.conformance === 'conformant'); return result;
}
const contextOracle = [
  '@agent-teams/engineering-foundation@1.4.0', '@microsoft/api-extractor@7.58.12',
  '@microsoft/api-extractor-model@7.33.10', '@rushstack/node-core-library@5.23.3',
  '@rushstack/problem-matcher@0.2.1', '@rushstack/terminal@0.24.2', '@rushstack/ts-command-line@5.3.12',
].map(id => id + '(@types/node@24.13.3)').sort();
const foundation = '@agent-teams/engineering-foundation@1.4.0(@types/node@24.13.3)';
const core = '@rushstack/node-core-library@5.23.3(@types/node@24.13.3)';
const terminal = '@rushstack/terminal@0.24.2(@types/node@24.13.3)';

test('retained external A proves whole managed-restoration lock conformance', async () => {
  const request = await retained(), result = accepted(checkManagedRestorationLockV1(request));
  const oracle: unknown = parseDocument(Buffer.from(request.actualLockBytes).toString('utf8')).toJSON();
  assert.equal(result.expectedLockDigest, 'sha256:' + createHash('sha256').update('managed-restoration-lock/v1\n').update(canonical(oracle)).digest('hex'));
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.provenance.contextLocators, contextOracle);
  assert.deepEqual(result.provenance.borrowedCoordinates, ['@types/node@24.13.3', 'undici-types@7.18.2']);
  assert.deepEqual(result.provenance.removedSourceCoordinates, [
    '@agent-teams/docs-protocol-agent-teams@0.2.13', '@agent-teams/docs-protocol@0.6.2',
    '@agent-teams/document-authoring@0.3.2', '@agent-teams/engineering-foundation@1.7.0', '@agent-teams/repository-mutation@0.2.2',
  ].sort());
  assert.deepEqual([result.provenance.originalSnapshotCount, result.provenance.managedSnapshotCount,
    result.provenance.foreignOnlySnapshotCount, result.provenance.wholeSnapshotCount], [83, 85, 42, 127]);
  assert.equal(result.provenance.originalPackageManager, 'pnpm@11.20.0');
  assert.equal(result.provenance.originalClosureSha256, request.selection.originalClosureSha256);
  assert.ok(!Object.hasOwn(result, 'cohortAdmissible') && !Object.hasOwn(result, 'restoreAllowed'));
});

const mutations: readonly [string, (document: Document) => void][] = [
  ['wrong types', d => d.setIn(['snapshots', core, 'optionalDependencies', '@types/node'], '24.19.1')],
  ['hard node edge', d => { d.deleteIn(['snapshots', core, 'optionalDependencies']); d.setIn(['snapshots', core, 'dependencies', '@types/node'], '24.13.3'); }],
  ['wrong undici', d => d.setIn(['snapshots', '@types/node@24.13.3', 'dependencies', 'undici-types'], '7.18.3')],
  ['doubled suffix', d => d.setIn(['snapshots', foundation, 'dependencies', '@microsoft/api-extractor'], '7.58.12(@types/node@24.13.3)(@types/node@24.13.3)')],
  ['suffix outside C', d => d.setIn(['snapshots', '@agent-teams/docs-protocol@0.6.0', 'dependencies', 'minisearch'], '7.2.0(@types/node@24.13.3)')],
  ['missing ancestor suffix', d => d.setIn(['snapshots', foundation, 'dependencies', '@microsoft/api-extractor-model'], '7.33.10')],
  ['dual node snapshot', d => d.setIn(['snapshots', '@rushstack/terminal@0.24.2'], {})],
  ['dual formats snapshot', d => d.setIn(['snapshots', 'ajv-formats@3.0.1(ajv@8.20.0)'], { optionalDependencies: { ajv: '8.20.0' } })],
  ['collision replacement', d => { d.deleteIn(['snapshots', terminal]); d.setIn(['snapshots', '@rushstack/terminal@0.24.2'], {}); }],
  ['dangling edge', d => d.setIn(['snapshots', terminal, 'dependencies', 'supports-color'], '999.0.0')],
  ['third borrowed edge', d => d.setIn(['snapshots', foundation, 'dependencies', '@noble/hashes'], '2.4.0')],
  ['foreign field', d => d.setIn(['packages', '@noble/hashes@2.4.0', 'engines', 'node'], '>=26')],
  ['foreign mode', d => d.setIn(['packages', '@oxlint/binding-darwin-arm64@1.80.0', 'cpu'], ['x64'])],
  ['shared yaml', d => d.setIn(['packages', 'yaml@2.9.0', 'hasBin'], false)],
  ['stale Source coordinate', d => { d.setIn(['packages', '@agent-teams/repository-mutation@0.2.2'], { resolution: { integrity: 'stale' } }); d.setIn(['snapshots', '@agent-teams/repository-mutation@0.2.2'], {}); }],
  ['formats wrong AJV', d => d.setIn(['snapshots', 'ajv-formats@3.0.1', 'dependencies', 'ajv'], '8.18.0')],
  ['formats optional AJV', d => { d.deleteIn(['snapshots', 'ajv-formats@3.0.1', 'dependencies']); d.setIn(['snapshots', 'ajv-formats@3.0.1', 'optionalDependencies'], { ajv: '8.20.0' }); }],
  ['formats peer metadata', d => d.setIn(['packages', 'ajv-formats@3.0.1', 'peerDependenciesMeta'], { ajv: { optional: true } })],
  ['draft04 peer', d => d.setIn(['snapshots', 'ajv-draft-04@1.0.0(ajv@8.20.0)', 'optionalDependencies', 'ajv'], '8.18.0')],
  ['parent missing AJV', d => d.deleteIn(['snapshots', core, 'dependencies', 'ajv'])],
  ['duplicate AJV context', d => d.setIn(['snapshots', 'ajv@8.20.0(ajv@8.18.0)'], {})],
  ['tsdoc AJV collapsed', d => d.setIn(['snapshots', '@microsoft/tsdoc-config@0.18.2', 'dependencies', 'ajv'], '8.20.0')],
  ['removed AJV818', d => { d.deleteIn(['packages', 'ajv@8.18.0']); d.deleteIn(['snapshots', 'ajv@8.18.0']); }],
  ['SRI changed', d => d.setIn(['packages', 'ajv@8.20.0', 'resolution', 'integrity'], 'sha512-changed')],
  ['catalog changed', d => d.setIn(['catalogs', 'default', '@types/node', 'version'], '24.19.1')],
  ['options changed', d => d.setIn(['settings', 'autoInstallPeers'], true)],
  ['foreign importer changed', d => d.setIn(['importers', 'packages/contexts/supply', 'dependencies', 'yaml', 'specifier'], '2.9.0')],
  ['managed importer changed', d => d.setIn(['importers', '.', 'devDependencies', '@agent-teams/docs-protocol', 'specifier'], '^0.6.0')],
  ['managed root section moved', d => { d.deleteIn(['importers', '.', 'devDependencies', '@agent-teams/docs-protocol']); d.setIn(['importers', '.', 'dependencies', '@agent-teams/docs-protocol'], { specifier: '0.6.0', version: '0.6.0' }); }],
  ['unknown nested field', d => d.setIn(['packages', 'ajv@8.20.0', 'resolution', 'extension'], { nested: [null, false] })],
  ['numeric coercion', d => d.setIn(['lockfileVersion'], 9)],
  ['absent to null', d => d.setIn(['snapshots', '@agent-teams/repository-mutation@0.2.0', 'dependencies'], null)],
  ['absent to empty', d => d.setIn(['snapshots', '@agent-teams/repository-mutation@0.2.0', 'dependencies'], {})],
  ['empty to scalar', d => d.setIn(['snapshots', '@agent-teams/repository-mutation@0.2.0'], '')],
];
for (const [name, mutate] of mutations) {test('whole typed A rejects ' + name, async () => {
  const request = await retained(), baseline = accepted(checkManagedRestorationLockV1(request));
  const result = checkManagedRestorationLockV1(editActual(request, mutate));
  assert.equal(result.conformance, 'nonconformant'); assert.ok(result.diagnostics.length > 0);
  assert.equal(result.expectedLockDigest, baseline.expectedLockDigest, 'A must not select or derive E');
});}

test('all mismatch paths are retained and object order is immaterial', async () => {
  const request = await retained();
  accepted(checkManagedRestorationLockV1(editActual(request, d => {
    const packages = d.get('packages', true); assert.ok(isMap(packages)); packages.items.reverse();
  })));
  const result = checkManagedRestorationLockV1(editActual(request, d => {
    d.setIn(['settings', 'autoInstallPeers'], true); d.setIn(['catalogs', 'default', '@types/node', 'version'], '24.19.1');
    d.setIn(['snapshots', core, 'optionalDependencies', '@types/node'], '24.19.1');
  }));
  assert.equal(result.conformance, 'nonconformant');
  for (const path of [['settings', 'autoInstallPeers'], ['catalogs', 'default', '@types/node', 'version'],
    ['snapshots', core, 'optionalDependencies', '@types/node']])
    {assert.ok(result.diagnostics.some(row => JSON.stringify(row.path) === JSON.stringify(path)));}
});

test('Source extensions and comments retain type, order and semantic placement', async () => {
  const request = await retained(), source = parseDocument(Buffer.from(request.sourceLockBytes).toString('utf8'));
  const actual = parseDocument(Buffer.from(request.actualLockBytes).toString('utf8'));
  for (const document of [source, actual]) {
    document.set('retainedExtension', { nested: [null, {}, [], true, 1, '1'] });
    const settings = document.get('settings', true); assert.ok(isMap(settings)); settings.commentBefore = ' placement witness';
  }
  const augmented = { ...withSource(request, Buffer.from(source.toString())), actualLockBytes: Buffer.from(actual.toString()) };
  accepted(checkManagedRestorationLockV1(augmented));
  for (const value of [null, {}, [], false, '1', [null, {}, [], true, '1', 1]]) {
    const result = checkManagedRestorationLockV1(editActual(augmented, d => d.setIn(['retainedExtension', 'nested'], value)));
    assert.equal(result.conformance, 'nonconformant');
  }
  for (const moved of [false, true]) {
    const result = checkManagedRestorationLockV1(editActual(augmented, d => {
      const settings = d.get('settings', true); assert.ok(isMap(settings)); settings.commentBefore = null;
      const catalogs = d.get('catalogs', true); assert.ok(isMap(catalogs)); catalogs.commentBefore = moved ? ' placement witness' : ' changed witness';
    }));
    assert.ok(result.diagnostics.some(row => row.code === 'preservation'));
  }
  assert.equal(checkManagedRestorationLockV1(editActual(augmented, d => { d.delete('retainedExtension'); })).conformance, 'nonconformant');
});

test('public byte boundary rejects invented facts, wrong selections and archive sets', async () => {
  const request = await retained();
  for (const invented of [{ ...request, SRIverified: true }, { ...request, admittedFacts: {} }, { ...request, evaluator: () => true }])
    {assert.equal(checkManagedRestorationLockV1(invented).conformance, 'nonconformant');}
  for (const selection of [{ ...request.selection, originalClosureSha256: '0'.repeat(64) },
    { ...request.selection, sourceLockSha256: '0'.repeat(64) }, { ...request.selection, sourceLockBlob: '0'.repeat(40) }])
    {assert.equal(checkManagedRestorationLockV1({ ...request, selection }).conformance, 'nonconformant');}
  const entries = Object.entries(request.archiveBytes), first = entries[0]; assert.ok(first);
  for (const archiveBytes of [Object.fromEntries(entries.slice(1)), { ...request.archiveBytes, 'extra@1.0.0': first[1] }])
    {assert.equal(checkManagedRestorationLockV1({ ...request, archiveBytes }).conformance, 'nonconformant');}
  const corrupted = Buffer.from(first[1]); corrupted[0] = (corrupted[0] ?? 0) ^ 1;
  assert.equal(checkManagedRestorationLockV1({ ...request, archiveBytes: { ...request.archiveBytes, [first[0]]: corrupted } }).conformance, 'nonconformant');
  for (const extra of ['\nsettings: {}\n', '\nx: &a {}\ny: *a\n'])
    {assert.equal(checkManagedRestorationLockV1({ ...request, actualLockBytes: Buffer.concat([Buffer.from(request.actualLockBytes), Buffer.from(extra)]) }).conformance, 'nonconformant');}
});

function publicTypes(request: ManagedRestorationLockV1Request, result: ManagedRestorationLockV1Result): void {
  // @ts-expect-error Public requests contain bytes, never caller-verified declarations.
  const facts: ManagedRestorationLockV1Request = { ...request, admittedFacts: {} };
  // @ts-expect-error The public request has no executable evaluator seam.
  const callback: ManagedRestorationLockV1Request = { ...request, evaluator: () => true };
  // @ts-expect-error Conformance results cannot be used as Cohort admission receipts.
  const authority: { readonly cohortAdmissible: true } = result;
  if (result.conformance === 'conformant') { const digest: `sha256:${string}` = result.expectedLockDigest; void digest; }
  void facts; void callback; void authority;
}
void publicTypes;
