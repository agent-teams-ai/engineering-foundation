import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkReleaseCandidate,
  type DiagnosticCode, type LeafShape, type ReleaseCandidateInput,
} from '../../../packages/release-checks/dist/index.js';
import { releaseCandidateConformanceCases } from '../../../packages/release-checks/dist/features/candidate-checking/conformance.js';

type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
function fixture(id = 'direct-dependent-empty-and-unchanged-none'): Mutable<ReleaseCandidateInput> {
  const entry = releaseCandidateConformanceCases.find(item => item.id === id);
  assert(entry);
  // Materialize independent JSON observations; structuredClone preserves fixture aliases.
  return JSON.parse(JSON.stringify(entry.input)) as Mutable<ReleaseCandidateInput>;
}
function codes(input: unknown): readonly DiagnosticCode[] {
  const result = checkReleaseCandidate(input);
  assert.equal(result.outcome, 'rejected');
  return result.diagnostics.map(diagnostic => diagnostic.code);
}
const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const ordinaryFile = (character: string) => ({ type: 'file' as const, mode: '100644' as const, digest: digest(character) });
function alpha(input: Mutable<ReleaseCandidateInput>) {
  const observed = input.observed.manifests.find(item => item.manifestPath === 'packages/alpha/package.json');
  assert(observed?.after);
  return observed.after;
}

void test('normal JSON boundary rejects malformed, cyclic, sparse and oversized input with a coded report', () => {
  for (const input of [undefined, 1, 'json', {}, { schemaVersion: 2 }, { ...fixture(), unexpected: true }]) {
    assert.deepEqual(codes(input), ['input.invalid']);
  }
  const cycle: Record<string, unknown> = {}; cycle['self'] = cycle;
  const sparse: unknown[] = []; sparse.length = 3;
  const badDigest = fixture(); badDigest.observed.binding.engine.digest = 'f'.repeat(64);
  const tooDeep: Record<string, unknown> = {}; let current = tooDeep;
  for (let i = 0; i < 66; i += 1) { const next: Record<string, unknown> = {}; current['next'] = next; current = next; }
  for (const input of [cycle, sparse, tooDeep, badDigest, { ...fixture(), observed: Infinity }, Object.create({ inherited: true })]) {
    assert.deepEqual(codes(input), ['input.invalid']);
  }
  const tooLarge = fixture(); alpha(tooLarge).semantic['note'] = 'x'.repeat(8_388_609);
  assert.deepEqual(codes(tooLarge), ['input.invalid']);
  let getterCalled = false;
  const accessor = Object.defineProperty({}, 'expected', { enumerable: true, get() { getterCalled = true; return {}; } });
  assert.deepEqual(codes(accessor), ['input.invalid']);
  assert.equal(getterCalled, false);
});

void test('complete inventory rejects missing, extra, duplicate and contradictory manifest identities', () => {
  const missing = fixture(); missing.observed.manifests = missing.observed.manifests.filter(item => item.manifestPath !== 'package.json');
  assert(codes(missing).includes('manifest.missing'));
  const extra = fixture(); extra.observed.manifests.push({ manifestPath: 'packages/foreign/package.json', before: null, after: null });
  assert(codes(extra).includes('package.unknown'));
  const duplicate = fixture(); duplicate.expected.packages.push(structuredClone(duplicate.expected.packages[0]!));
  assert(codes(duplicate).includes('identity.duplicate'));
  const foreignRoot = fixture(); foreignRoot.expected.packages[1]!.manifestPath = 'packages/beta/package.json';
  assert(codes(foreignRoot).includes('inventory.ambiguous'));
  const identity = fixture(); alpha(identity).semantic['name'] = '@fixture/swap';
  assert(codes(identity).includes('manifest.identity'));
  const nested = fixture('nested-packages-without-root-manifest');
  nested.observed.manifests = nested.observed.manifests.filter(item => item.manifestPath !== 'packages/alpha/package.json');
  assert(codes(nested).includes('manifest.missing'));
  const empty = fixture('no-release-with-empty-intent-and-none');
  empty.expected.packages = []; empty.expected.plan.releases = []; empty.observed.manifests = [];
  assert.deepEqual(codes(empty), ['inventory.ambiguous']);
});

void test('all non-version manifest fields remain protected independently of permission labels', () => {
  for (const [key, value] of [
    ['scripts', { prepare: 'unexpected-effect' }],
    ['exports', { '.': './other.js' }],
    ['dependencies', { arbitrary: '1.0.0' }],
  ] as const) {
    const input = fixture(); alpha(input).semantic[key] = value;
    const permission = input.expected.permittedChanges.find(item => item.path === 'packages/alpha/package.json')!;
    const change = input.observed.diff.find(item => item.path === 'packages/alpha/package.json')!;
    permission.classification = 'host-approved'; change.classification = 'host-approved';
    assert(codes(input).includes('manifest.content-changed'), key);
  }
  const privateRoot = fixture(); const root = privateRoot.observed.manifests.find(item => item.manifestPath === 'package.json')!;
  assert(root.before && root.after);
  root.after.semantic['scripts'] = { prepare: 'hidden' }; root.after.file = ordinaryFile('e');
  privateRoot.observed.diff.push({ path: 'package.json', classification: 'host', kind: 'modified', before: root.before.file, after: root.after.file });
  privateRoot.expected.permittedChanges.push({ path: 'package.json', classification: 'host', kind: 'modified', before: { type: 'file', mode: '100644' }, after: { type: 'file', mode: '100644' }, contentAuthority: 'fixture-host' });
  assert(codes(privateRoot).includes('manifest.content-changed'));
});

void test('exact plan values, reciprocal direct links and dependent records have distinct meanings', () => {
  const wrongOld = fixture(); wrongOld.expected.plan.releases.find(item => item.packageName === '@fixture/alpha')!.oldVersion = '0.9.0';
  assert(codes(wrongOld).includes('plan.version-mismatch'));
  const contradictoryNone = fixture(); contradictoryNone.expected.plan.releases.find(item => item.packageName === '@fixture/beta')!.type = 'none';
  assert.deepEqual(codes(contradictoryNone), ['plan.version-mismatch']);
  const missingDependent = fixture(); missingDependent.expected.plan.releases = missingDependent.expected.plan.releases.filter(item => item.packageName !== '@fixture/beta');
  assert(codes(missingDependent).includes('plan.unexpected-version'));
  const missingDirect = fixture(); missingDirect.expected.plan.releases.find(item => item.packageName === '@fixture/alpha')!.intentIds = [];
  assert(codes(missingDirect).includes('intent.coverage'));
  const unknown = fixture(); unknown.expected.plan.releases.push({ packageName: '@fixture/unknown', manifestPath: 'packages/unknown/package.json', type: 'patch', oldVersion: '2.0.0', newVersion: '2.0.1', intentIds: [] });
  assert(codes(unknown).includes('package.unknown'));
  const foreignLink = fixture(); foreignLink.expected.plan.releases.find(item => item.packageName === '@fixture/beta')!.intentIds = ['direct'];
  assert(codes(foreignLink).includes('intent.coverage'));
  const absentIsNotNull = fixture(); absentIsNotNull.expected.packages[0]!.before.semantic['version'] = null;
  assert.deepEqual(codes(absentIsNotNull), ['input.invalid']);
});

void test('retained, ignored and unversioned intents never become implicitly consumable', () => {
  for (const id of ['ignored', 'private']) {
    const input = fixture(); const intent = input.expected.intents.find(item => item.id === id)!;
    input.expected.plan.consumptions.push({ intentId: id, effect: { kind: 'remove' } });
    input.observed.consumptions.push({ intentId: id, digest: intent.digest, effect: { kind: 'remove' } });
    input.expected.permittedChanges.push({ path: intent.path, classification: 'intent', kind: 'deleted', before: { type: 'file', mode: '100644' }, after: null, contentAuthority: 'fixture-host' });
    input.observed.diff.push({ path: intent.path, classification: 'intent', kind: 'deleted', before: { ...ordinaryFile('a'), digest: intent.digest }, after: null });
    assert(codes(input).includes('intent.consumption'));
  }
  const retained = fixture();
  retained.expected.intents.forEach(intent => { intent.participation = 'retained'; });
  retained.expected.plan = { releases: [{ packageName: '@fixture/private', manifestPath: 'packages/private/package.json', type: 'none', oldVersion: null, newVersion: null, intentIds: [] }], consumptions: [] };
  retained.expected.permittedChanges = [];
  retained.observed.consumptions = []; retained.observed.diff = [];
  retained.observed.manifests = retained.expected.packages.map(p => ({ manifestPath: p.manifestPath, before: p.before, after: p.before }));
  assert.equal(checkReleaseCandidate(retained).outcome, 'passed', 'already applied pending-source files must not be demanded again');
});

void test('consumption effects require actual exact file evidence and cannot use a manifest as metadata proof', () => {
  const missing = fixture(); missing.observed.consumptions = missing.observed.consumptions.filter(item => item.intentId !== 'direct');
  assert(codes(missing).includes('intent.consumption'));
  const wrongBytes = fixture(); wrongBytes.observed.diff.find(item => item.path === '.intent/direct.md')!.before = ordinaryFile('a');
  assert(codes(wrongBytes).includes('intent.consumption'));
  const recorded = fixture('existing-retained-file-consumption');
  recorded.expected.plan.consumptions.find(item => item.intentId === 'direct')!.effect = { kind: 'record', evidencePath: 'packages/alpha/package.json' };
  recorded.observed.consumptions.find(item => item.intentId === 'direct')!.effect = { kind: 'record', evidencePath: 'packages/alpha/package.json' };
  assert(codes(recorded).includes('intent.consumption'));
  const missingMetadata = fixture('existing-retained-file-consumption'); missingMetadata.observed.diff = missingMetadata.observed.diff.filter(item => item.path !== '.release-state.json');
  assert(codes(missingMetadata).includes('intent.consumption'));
  const noRelease = fixture('no-release-with-empty-intent-and-none');
  noRelease.expected.plan.consumptions.push({ intentId: 'empty', effect: { kind: 'remove' } });
  assert(codes(noRelease).includes('intent.consumption'));
});

void test('complete diff and snapshot cross-links reject omissions, wrong hashes, unsupported modes and no-op rows', () => {
  const omitted = fixture(); omitted.observed.diff = omitted.observed.diff.filter(item => item.path !== 'packages/alpha/package.json');
  assert(codes(omitted).includes('diff.inconsistent'));
  const hash = fixture(); hash.observed.diff.find(item => item.path === 'packages/alpha/package.json')!.after = ordinaryFile('f');
  assert(codes(hash).includes('diff.inconsistent'));
  const mode = fixture(); mode.observed.diff.find(item => item.path === 'packages/alpha/package.json')!.after = { type: 'file', mode: '100755', digest: digest('2') };
  assert(codes(mode).includes('diff.unexpected'));
  const noOp = fixture(); noOp.observed.diff.push({ path: 'unchanged.txt', classification: 'host', kind: 'modified', before: ordinaryFile('c'), after: ordinaryFile('c') });
  assert(codes(noOp).includes('diff.inconsistent'));
  const source = fixture(); source.observed.manifests[1]!.before!.file = ordinaryFile('f');
  assert(codes(source).includes('manifest.source-mismatch'));
  const format = fixture('no-release-with-empty-intent-and-none');
  format.observed.manifests[0]!.after!.file = ordinaryFile('f');
  assert(codes(format).includes('diff.inconsistent'));
});

void test('binding comparison covers each source, engine, config, intent, plan and policy identity', () => {
  for (const key of ['configDigest', 'inventoryDigest', 'policyDigest', 'intentsDigest', 'planDigest'] as const) {
    const input = fixture(); input.observed.binding[key] = digest('1');
    assert.deepEqual(codes(input), ['binding.mismatch'], key);
  }
  for (const section of ['source', 'engine'] as const) {
    const input = fixture(); input.observed.binding[section].digest = digest('1');
    assert.deepEqual(codes(input), ['binding.mismatch'], section);
  }
});

void test('reports are deterministic, detached from input and keep literal case-sensitive identities', () => {
  const input = fixture(); alpha(input).semantic['scripts'] = { build: 'unexpected' };
  const before = structuredClone(input); const first = checkReleaseCandidate(input);
  input.expected.packages.reverse(); input.expected.intents.reverse(); input.expected.plan.releases.reverse();
  input.expected.permittedChanges.reverse(); input.observed.manifests.reverse(); input.observed.diff.reverse();
  assert.deepEqual(checkReleaseCandidate(input), first);
  assert.equal(before.observed.manifests[1]!.after!.semantic['version'], '1.1.0');
  alpha(input).semantic['version'] = '9.9.9';
  assert.equal(first.packageChanges[0]?.newVersion, '1.1.0');
  const differentCase = fixture(); differentCase.expected.plan.releases.find(item => item.packageName === '@fixture/alpha')!.packageName = '@fixture/Alpha';
  assert(codes(differentCase).includes('package.unknown'));
});

// Public type/mode pairing remains checked by the strict TypeScript route.
const fileShape: LeafShape = { type: 'file', mode: '100644' };
// @ts-expect-error symlink mode cannot be represented as an ordinary file.
const invalidShape: LeafShape = { type: 'file', mode: '120000' };
void fileShape; void invalidShape;
