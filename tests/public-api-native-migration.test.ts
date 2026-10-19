import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { NodeChangeFingerprint } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/crypto/node-change-fingerprint.js';
import { promotePublicApiBaselines } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/promote-public-api-baselines.js';
import { evaluatePublicApiCompatibility, classifyPublicApiChange } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/evaluate-public-api-compatibility.js';
import { PUBLIC_API_COMPATIBILITY_RULES } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/rules.js';
import { foundationReport, capabilityReport } from '../packages/engineering-foundation/dist/features/validation-reporting/api.js';
import type { PublicApiCompatibilityPolicy, PublicApiSnapshot } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/public-api.js';
import type { PublicApiRepository } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/ports/public-api-repository.js';
import type { FoundationCheckReport } from '../packages/engineering-foundation/dist/features/validation-reporting/api.js';
import { assertNativeMigrationReview, assertNativeMigrationOrdinaryReport, prepareNativeMigrationPromotion, migrationBytes, migrationDigest, type NativeMigrationReview, type NativeMigrationObservation } from '../scripts/public-api-native-migration.ts';
import { nativeMigrationPackageNames, nativeMigrationToolDifference, observeNativeMigration } from '../scripts/public-api-native-migration-observation.ts';

type Dependencies = Parameters<typeof promotePublicApiBaselines>[1];
const fingerprint = new NodeChangeFingerprint();
function fixture() {
  const policy: PublicApiCompatibilityPolicy = { schemaVersion: 1, acceptedDecisionBaselinePath: 'architecture/decisions/accepted-decisions.json', changesetDirectory: '.changeset', packages: nativeMigrationPackageNames.map(packageName => {
    const local = packageName.split('/').at(-1)!;
    return { packageName, packageRoot: `packages/${local}`, manifestPath: `packages/${local}/package.json`, tsconfigPath: `packages/${local}/tsconfig.json`, releasedBaselinePath: `architecture/public-api/${local}.json`, approvedBreakingChanges: [], entrypoints: [{ exportPath: '.', declarationEntryPoint: `packages/${local}/dist/index.d.ts` }], nonTypeExports: [] };
  }) };
  const packages = policy.packages.map(p => {
    const baseline: PublicApiSnapshot = { schemaVersion: 1, packageName: p.packageName, packageVersion: '1.0.0', extractorVersion: '7.58.12', entrypoints: [{ exportPath: '.', items: [{ canonicalReference: `${p.packageName}!Value:type`, kind: 'TypeAlias', parentReference: `${p.packageName}!`, parentKind: 'EntryPoint', signature: 'export type Value = string;' }] }] };
    const nativeReleased: PublicApiSnapshot = { ...baseline, extractorVersion: 'typescript-native/7.0.2' };
    return { packageName: p.packageName, baselineDigest: migrationDigest(migrationBytes(baseline)), archiveDigest: migrationDigest(Buffer.from(p.packageName)), archiveIntegrity: fingerprint.sha512Integrity(p.packageName), configDigest: migrationDigest(Buffer.from('{}')), releasedInputsDigest: migrationDigest(Buffer.from(`inputs:${p.packageName}`)), nativeReleasedDigest: migrationDigest(migrationBytes(nativeReleased)), baseline, nativeReleased, nativeCandidate: structuredClone(nativeReleased) };
  });
  const toolDiff = nativeMigrationToolDifference(packages);
  const observation: NativeMigrationObservation = { kind: 'foundation:public-api-native-migration:observation:1', policyDigest: migrationDigest(migrationBytes(policy)), toolchainIdentity: 'fixture-native7', packages, toolDiff, toolDiffDigest: migrationDigest(migrationBytes(toolDiff)), typedDiagnostics: [], artifactDiagnostics: [] };
  const review: NativeMigrationReview = { kind: 'foundation:public-api-native-migration:review:1', from: '7.58.12', to: 'typescript-native/7.0.2', baselineSourceCommit: 'a'.repeat(40), policyDigest: observation.policyDigest, toolDiffDigest: observation.toolDiffDigest, packages: packages.map((p, index) => ({ packageName: p.packageName, baselinePath: policy.packages[index]!.releasedBaselinePath, baselineDigest: p.baselineDigest, archiveDigest: p.archiveDigest, archiveIntegrity: p.archiveIntegrity, configDigest: p.configDigest, releasedInputsDigest: p.releasedInputsDigest, nativeReleasedDigest: p.nativeReleasedDigest })) };
  return { policy, observation, review };
}

function ordinaryReport(f: ReturnType<typeof fixture>): FoundationCheckReport {
  const diagnostics = f.policy.packages.map((p, index) => evaluatePublicApiCompatibility({ policy: p, released: f.observation.packages[index]!.baseline, current: f.observation.packages[index]!.nativeCandidate, change: classifyPublicApiChange(f.observation.packages[index]!.baseline, f.observation.packages[index]!.nativeCandidate, fingerprint), releaseEvidence: { packageName: p.packageName, packageVersion: '1.0.0' }, acceptedDecision: undefined })).flat();
  return foundationReport({ foundationVersion: '1.8.0', coverage: 'full', capabilities: [capabilityReport({ capabilityId: 'architecture.source-dependencies', capabilityConfigSchemaVersion: 2 }), capabilityReport({ capabilityId: 'package.public-api-compatibility', capabilityConfigSchemaVersion: 1, diagnostics })] });
}
const expectedCapabilities = [{ capabilityId: 'architecture.source-dependencies', capabilityConfigSchemaVersion: 2 }, { capabilityId: 'package.public-api-compatibility', capabilityConfigSchemaVersion: 1 }];

async function withPromotionFixture(action: (f: ReturnType<typeof fixture> & { root: string; typed: Dependencies; artifacts: Dependencies; writes: string[]; failNext: { packageName?: string } }) => Promise<void>) {
  const f = fixture(); const root = await mkdtemp(join(tmpdir(), 'native-api-migration-'));
  const cached = new Map<string, Buffer>(); const writes: string[] = []; const failNext: { packageName?: string } = {};
  for (const p of f.policy.packages) { await mkdir(dirname(join(root, p.releasedBaselinePath)), { recursive: true }); await writeFile(join(root, p.releasedBaselinePath), migrationBytes(f.observation.packages.find(x => x.packageName === p.packageName)!.baseline)); }
  const repository: PublicApiRepository = {
    readReleasedBaseline: async (_root, p) => { const b = await readFile(join(root, p.releasedBaselinePath)); cached.set(p.packageName, b); return JSON.parse(b.toString('utf8')) as PublicApiSnapshot; },
    readReleaseEvidence: async (_root, _changesets, p) => ({ packageName: p.packageName, packageVersion: f.observation.packages.find(x => x.packageName === p.packageName)!.nativeCandidate.packageVersion, declaredBump: 'major' }),
    describeReleasedBaselineWrite: async (_root, p, snapshot) => ({ destination: p.releasedBaselinePath, operation: 'replace', preimageDigest: migrationDigest(cached.get(p.packageName)!), proposedDigest: migrationDigest(migrationBytes(snapshot)) }),
    writeReleasedBaseline: async (_root, p, snapshot) => {
      if (failNext.packageName === p.packageName) { delete failNext.packageName; throw new Error('simulated process interruption'); }
      assert.deepEqual(await readFile(join(root, p.releasedBaselinePath)), cached.get(p.packageName), 'writer retains actual cached physical preimage');
      await writeFile(join(root, p.releasedBaselinePath), migrationBytes(snapshot)); writes.push(p.packageName);
    }
  };
  const typed: Dependencies = { repository, fingerprint, acceptedDecisionEvidence: { readAcceptedDecisionEvidence: async () => ({ acceptedDecisionIds: [], acceptedDecisionPaths: [] }) }, extractor: { extract: async (_root, p) => f.observation.packages.find(x => x.packageName === p.packageName)!.nativeCandidate } };
  const artifact = (name: string): PublicApiSnapshot => ({ schemaVersion: 1, packageName: name, packageVersion: f.observation.packages.find(x => x.packageName === name)!.nativeCandidate.packageVersion, extractorVersion: 'package-artifact-inventory/1', entrypoints: [{ exportPath: '.', items: [] }] });
  const artifacts: Dependencies = { ...typed, repository: { ...repository, readReleasedBaseline: async (_root, p) => artifact(p.packageName), writeReleasedBaseline: async () => { throw new Error('unchanged artifact surface must not write'); } }, extractor: { extract: async (_root, p) => artifact(p.packageName) } };
  try { await action({ ...f, root, typed, artifacts, writes, failNext }); } finally { await rm(root, { recursive: true, force: true }); }
}

test('named content review binds the complete eight-package B/A packet', () => {
  const f = fixture(); assert.doesNotThrow(() => assertNativeMigrationReview(f.observation, f.review, f.policy));
  assert.throws(() => assertNativeMigrationReview(f.observation, { ...f.review, packages: f.review.packages.slice(1) }, f.policy), /eight-package/u);
  assert.throws(() => assertNativeMigrationReview(f.observation, { ...f.review, toolDiffDigest: migrationDigest(Buffer.from('other')) }, f.policy), /entire tool difference/u);
  assert.throws(() => assertNativeMigrationReview(f.observation, { ...f.review, packages: f.review.packages.map((p, i) => i === 0 ? { ...p, baselinePath: 'architecture/public-api/other.json' } : p) }, f.policy), /anchor/u);
  for (const key of ['baselineDigest', 'archiveDigest', 'configDigest', 'releasedInputsDigest', 'nativeReleasedDigest'] as const) {assert.throws(() => assertNativeMigrationReview(f.observation, { ...f.review, packages: f.review.packages.map((p, i) => i === 0 ? { ...p, [key]: migrationDigest(Buffer.from('other')) } : p) }, f.policy), /reviewed|identity/u);}
  assert.throws(() => assertNativeMigrationReview(f.observation, { ...f.review, verified: true } as NativeMigrationReview, f.policy), /unknown/u);
});

test('historical tool migration cannot discard exports, identities or parents', () => {
  const f = fixture(); const row = f.observation.packages[0]!;
  assert.throws(() => nativeMigrationToolDifference([{ ...row, nativeReleased: { ...row.nativeReleased, entrypoints: [] } }]), /coverage/u);
  assert.throws(() => nativeMigrationToolDifference([{ ...row, nativeReleased: { ...row.nativeReleased, entrypoints: [{ exportPath: '.', items: [] }] } }]), /identity/u);
  const item = row.nativeReleased.entrypoints[0]!.items[0]!;
  assert.throws(() => nativeMigrationToolDifference([{ ...row, nativeReleased: { ...row.nativeReleased, entrypoints: [{ exportPath: '.', items: [{ ...item, parentKind: 'Namespace' }] }] } }]), /parent/u);
});

test('ordinary mismatch remains an exact retained negative alongside native comparison', async () => {
  const f = fixture(); const report = ordinaryReport(f); const args = { ...f, report, exitCode: 1, expectedCapabilities };
  await assertNativeMigrationOrdinaryReport(args);
  assert.equal(report.outcome, 'violations'); assert.equal(report.summary.errors, 8);
  assert.equal(report.capabilities[1]!.diagnostics[0]!.ruleId, PUBLIC_API_COMPATIBILITY_RULES.baselineToolMismatch.id);
  await assert.rejects(assertNativeMigrationOrdinaryReport({ ...args, exitCode: 0 }), /ordinary full report/u);
  await assert.rejects(assertNativeMigrationOrdinaryReport({ ...args, report: { ...report, coverage: 'selected' } }), /ordinary full report/u);
  await assert.rejects(assertNativeMigrationOrdinaryReport({ ...args, expectedCapabilities: expectedCapabilities.slice(1) }), /inventory/u);
  const wrong = structuredClone(report); const diagnostic = wrong.capabilities[1]!.diagnostics[0]!;
  await assert.rejects(assertNativeMigrationOrdinaryReport({ ...args, report: { ...wrong, capabilities: [wrong.capabilities[0]!, { ...wrong.capabilities[1]!, diagnostics: [{ ...diagnostic, location: { path: 'wrong.json' } }, ...wrong.capabilities[1]!.diagnostics.slice(1)] }] } }), /shapes/u);
  await assert.rejects(assertNativeMigrationOrdinaryReport({ ...args, observation: { ...f.observation, artifactDiagnostics: [diagnostic] } }), /native candidate/u);
});

test('ordinary promotion still rejects tool mismatch even for identical signatures', async () => withPromotionFixture(async f => {
  await assert.rejects(promotePublicApiBaselines({ consumerRoot: f.root, policy: f.policy }, f.typed), /API Extractor changed/u);
  assert.equal(f.writes.length, 0);
}));

test('version plan migrates every same-version unchanged typed B using actual B preimages', async () => withPromotionFixture(async f => {
  const plan = await prepareNativeMigrationPromotion({ consumerRoot: f.root, ...f }, { typed: f.typed, artifacts: f.artifacts });
  assert.equal(plan.writes.length, 8); assert.equal(f.writes.length, 0);
  for (const write of plan.writes) {assert.equal(write.preimageDigest, f.review.packages.find(x => x.baselinePath === write.destination)!.baselineDigest);}
  await plan.apply(); assert.equal(f.writes.length, 8);
  await plan.apply(); assert.equal(f.writes.length, 8);
}));

test('partial version application replays exact postimages and finishes remaining B files', async () => withPromotionFixture(async f => {
  const plan = await prepareNativeMigrationPromotion({ consumerRoot: f.root, ...f }, { typed: f.typed, artifacts: f.artifacts });
  f.failNext.packageName = f.policy.packages[3]!.packageName;
  await assert.rejects(plan.apply(), /interruption/u); assert.equal(f.writes.length, 3);
  const replay = await prepareNativeMigrationPromotion({ consumerRoot: f.root, ...f }, { typed: f.typed, artifacts: f.artifacts });
  assert.equal(replay.writes.length, 5);
  await replay.apply(); assert.equal(f.writes.length, 8); assert.equal(new Set(f.writes).size, 8);
}));

test('all physical destinations preflight before the first application write', async () => withPromotionFixture(async f => {
  const plan = await prepareNativeMigrationPromotion({ consumerRoot: f.root, ...f }, { typed: f.typed, artifacts: f.artifacts });
  await writeFile(join(f.root, f.policy.packages.at(-1)!.releasedBaselinePath), 'changed');
  await assert.rejects(plan.apply(), /preimage changed/u); assert.equal(f.writes.length, 0);
}));

test('application preflight keeps the originally captured consumer root', async () => withPromotionFixture(async f => {
  const options = { consumerRoot: f.root, ...f };
  const plan = await prepareNativeMigrationPromotion(options, { typed: f.typed, artifacts: f.artifacts });
  const decoy = await mkdtemp(join(tmpdir(), 'native-api-migration-decoy-'));
  try {
    for (const p of f.policy.packages) {
      await mkdir(dirname(join(decoy, p.releasedBaselinePath)), { recursive: true });
      await writeFile(join(decoy, p.releasedBaselinePath), migrationBytes(f.observation.packages.find(row => row.packageName === p.packageName)!.baseline));
    }
    await writeFile(join(f.root, f.policy.packages.at(-1)!.releasedBaselinePath), 'changed');
    options.consumerRoot = decoy;
    await assert.rejects(plan.apply(), /preimage changed/u);
    assert.equal(f.writes.length, 0);
  } finally { await rm(decoy, { recursive: true, force: true }); }
}));

test('reviewed observations cannot change during an awaited physical baseline read', async () => withPromotionFixture(async f => {
  const reached = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>(); let first = true;
  const repository: PublicApiRepository = { ...f.typed.repository, readReleasedBaseline: async (root, p, signal) => {
    const baseline = await f.typed.repository.readReleasedBaseline(root, p, signal);
    if (first) { first = false; reached.resolve(); await resume.promise; }
    return baseline;
  } };
  const typed = { ...f.typed, repository };
  const preparation = prepareNativeMigrationPromotion({ consumerRoot: f.root, ...f }, { typed, artifacts: f.artifacts });
  await reached.promise;
  const row = f.observation.packages.at(-1)!;
  const entrypoints = [{ exportPath: '.', items: [{ ...row.nativeCandidate.entrypoints[0]!.items[0]!, signature: 'export type Value = number;' }] }];
  Object.assign(row.nativeReleased, { entrypoints }); Object.assign(row.nativeCandidate, { entrypoints });
  resume.resolve();
  await assert.rejects(preparation, /candidate changed since/u);
  assert.equal(f.writes.length, 0);
}));

test('an initially complete postimage cannot revert while remaining baselines apply', async () => withPromotionFixture(async f => {
  const p = f.policy.packages[0]!; const row = f.observation.packages[0]!;
  await writeFile(join(f.root, p.releasedBaselinePath), migrationBytes(row.nativeCandidate));
  const plan = await prepareNativeMigrationPromotion({ consumerRoot: f.root, ...f }, { typed: f.typed, artifacts: f.artifacts });
  assert.equal(plan.writes.length, 7);
  await writeFile(join(f.root, p.releasedBaselinePath), migrationBytes(row.baseline));
  await assert.rejects(plan.apply(), /preimage changed/u);
  assert.equal(f.writes.length, 0);
}));

test('same-version candidate drift and an unapproved real break remain rejected', async () => withPromotionFixture(async f => {
  const row = f.observation.packages.at(-1)!; const changed = { ...row.nativeCandidate, entrypoints: [{ exportPath: '.', items: [{ ...row.nativeCandidate.entrypoints[0]!.items[0]!, signature: 'export type Value = number;' }] }] };
  const changedObservation = { ...f.observation, packages: f.observation.packages.map(x => x === row ? { ...x, nativeCandidate: changed } : x) };
  const typed = { ...f.typed, extractor: { extract: async (_root: string, p: { packageName: string }) => changedObservation.packages.find(x => x.packageName === p.packageName)!.nativeCandidate } };
  await assert.rejects(prepareNativeMigrationPromotion({ consumerRoot: f.root, ...f, observation: changedObservation }, { typed, artifacts: f.artifacts }), /changed after baseline/u);
  const released = { ...changed, packageVersion: '2.0.0' };
  const breakingObservation = { ...changedObservation, packages: changedObservation.packages.map(x => x.packageName === row.packageName ? { ...x, nativeCandidate: released } : x) };
  const breaking = { ...typed, repository: { ...typed.repository, readReleaseEvidence: async (_root: string, _path: string, p: { packageName: string }) => ({ packageName: p.packageName, packageVersion: p.packageName === row.packageName ? '2.0.0' : '1.0.0' }) }, extractor: { extract: async (_root: string, p: { packageName: string }) => breakingObservation.packages.find(x => x.packageName === p.packageName)!.nativeCandidate } };
  await assert.rejects(prepareNativeMigrationPromotion({ consumerRoot: f.root, ...f, observation: breakingObservation }, { typed: breaking, artifacts: f.artifacts }), /not approved/u);
  assert.equal(f.writes.length, 0);
}));

test('last-package artifact refusal leaves all typed baselines unchanged', async () => withPromotionFixture(async f => {
  const artifacts = { ...f.artifacts, extractor: { extract: async (...args: Parameters<Dependencies['extractor']['extract']>) => { if (args[1].packageName === f.policy.packages.at(-1)!.packageName) {throw new Error('artifact refusal');} return f.artifacts.extractor.extract(...args); } } };
  await assert.rejects(prepareNativeMigrationPromotion({ consumerRoot: f.root, ...f }, { typed: f.typed, artifacts }), /artifact refusal/u); assert.equal(f.writes.length, 0);
}));

test('a reviewed plan keeps its captured postimages when caller objects subsequently change', async () => withPromotionFixture(async f => {
  const expected = migrationBytes(f.observation.packages[0]!.nativeCandidate);
  const plan = await prepareNativeMigrationPromotion({ consumerRoot: f.root, ...f }, { typed: f.typed, artifacts: f.artifacts });
  Object.assign(f.observation.packages[0]!.nativeCandidate, { entrypoints: [] });
  await plan.apply(); assert.deepEqual(await readFile(join(f.root, f.policy.packages[0]!.releasedBaselinePath)), expected);
}));

test('candidate root cannot masquerade as historical archive data', async () => {
  const f = fixture();
  await assert.rejects(observeNativeMigration({ consumerRoot: '/tmp/same-candidate', releasedRoot: '/tmp/same-candidate', policy: f.policy, packages: f.policy.packages.map(p => ({ packageName: p.packageName, baselineBytes: new Uint8Array(), archiveBytes: new Uint8Array(), configBytes: new Uint8Array() })) }), /candidate cannot/u);
});
