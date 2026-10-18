import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { assertReportDestination, assertWorkingMigrationBaselines, nativeMigrationMain, ordinaryFailureResult, parseMigrationArguments, qualifyOrdinaryResult } from '../scripts/public-api-native-migration-cli.ts';
import { capabilityReport, foundationReport } from '../packages/engineering-foundation/dist/features/validation-reporting/api.js';
import type { PublicApiCompatibilityPolicy } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/public-api.js';
import { migrationBytes, migrationDigest, type NativeMigrationReview } from '../scripts/public-api-native-migration.ts';
import { nativeMigrationPackageNames } from '../scripts/public-api-native-migration-observation.ts';
import { assertVersionFiles, assertVersionRunBinding, assertVersionSnapshotUnchanged, parseVersionFileChanges, readVersionRunIdentity } from '../scripts/public-api-native-migration-version.ts';
import { runCommand } from '../scripts/pack-test-support.mjs';

const sha = 'a'.repeat(40); const repository = 'agent-teams-ai/engineering-foundation';
const context = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_JOB: 'release', GITHUB_SERVER_URL: 'https://github.com', GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release.yml@refs/heads/main`, GITHUB_WORKFLOW_SHA: sha, GITHUB_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
const workingBaselineBytes = (name: string, version = '1.9.0') => migrationBytes({ packageName: name, packageVersion: version, extractorVersion: '7.58.12', entrypoints: [] });

test('driver exposes only the two closed modes and qualify report destinations', () => {
  assert.deepEqual(parseMigrationArguments(['qualify', '--ordinary-report', '/tmp/ordinary.json', '--migration-report', '/tmp/migration.json']), { mode: 'qualify', ordinaryReport: '/tmp/ordinary.json', migrationReport: '/tmp/migration.json' });
  assert.deepEqual(parseMigrationArguments(['apply-version']), { mode: 'apply-version' });
  for (const args of [[], ['migrate'], ['qualify', '--consumer', '/tmp/other'], ['qualify', '--approve'], ['qualify', '--ordinary-report'], ['qualify', '--ordinary-report', 'a', '--ordinary-report', 'b'], ['apply-version', '--migration-report', '/tmp/report']]) {assert.throws(() => parseMigrationArguments(args), /expected|unsupported/u);}
});

test('report options cannot overwrite files within the source checkout', () => {
  const root = join(tmpdir(), 'fixed-foundation-checkout');
  for (const path of [root, join(root, 'architecture/public-api/engineering-foundation.json'), join(root, 'scripts/tool.ts')]) {assert.throws(() => assertReportDestination(root, path), /outside/u);}
  assert.equal(assertReportDestination(root, join(tmpdir(), 'native-ordinary.json')), join(tmpdir(), 'native-ordinary.json'));
});

test('ordinary failed child preserves complete stdout stderr and actual exit', async () => {
  let failure: unknown;
  try { await runCommand(process.execPath, ['--input-type=module', '-e', 'process.stdout.write("{\\"original\\":true}\\n"); process.stderr.write("retained stderr\\n"); process.exitCode=1;'], tmpdir()); }
  catch (error) { failure = error; }
  assert.deepEqual(ordinaryFailureResult(failure), { stdout: '{"original":true}\n', stderr: 'retained stderr\n', exitCode: 1 });
  assert.throws(() => ordinaryFailureResult(new Error('transport failure')), /transport failure/u);
  if (!(failure instanceof Error)) {assert.fail('expected managed child failure');}
  Object.assign(failure, { timedOut: true });
  assert.throws(() => ordinaryFailureResult(failure), /Command failed/u);
});

test('ordinary nonmigration failures reject before any archive acquisition', async () => {
  const report = foundationReport({ foundationVersion: '1.8.0', coverage: 'full', capabilities: [capabilityReport({ capabilityId: 'repository.security-baseline', capabilityConfigSchemaVersion: 1, diagnostics: [{ ruleId: 'repository.security-baseline.dependency-review-missing', severity: 'error', subject: 'fixture', message: 'Missing dependency review', location: { path: '.github/workflows/ci.yml' }, relatedLocations: [], evidence: [], remediation: 'Restore dependency review', requiresArchitectureReview: false }] })] });
  let acquired = false;
  await assert.rejects(qualifyOrdinaryResult({ stdout: JSON.stringify(report), stderr: '', exitCode: 1 }, async () => { acquired = true; throw new Error('archive acquisition must not run'); }), /ordinary full report/u);
  assert.equal(acquired, false);
});

test('ordinary passed report expires the migration without archive acquisition', async () => {
  const report = foundationReport({ foundationVersion: '1.8.0', coverage: 'full', capabilities: [capabilityReport({ capabilityId: 'repository.security-baseline', capabilityConfigSchemaVersion: 1 })] });
  const result = await qualifyOrdinaryResult({ stdout: JSON.stringify(report), stderr: '', exitCode: 0 }, async () => { throw new Error('archive acquisition must not run'); });
  assert.equal(result.outcome, 'ordinary-passed');
  assert.deepEqual(result.report, report);
});

test('workstation apply refuses before any acquisition or baseline write', async () => {
  assert.throws(() => readVersionRunIdentity({}), /only the existing/u);
  if (process.env['GITHUB_ACTIONS'] !== 'true') {await assert.rejects(nativeMigrationMain(['apply-version']), /only the existing/u);}
});

test('environment claims alone are insufficient and wrong release contexts reject', () => {
  for (const mutation of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'fork/engineering-foundation' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_JOB: 'test' }, { GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@refs/heads/main` }, { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) }, { GITHUB_RUN_ID: '00123' }, { GITHUB_RUN_ATTEMPT: '0' }]) {assert.throws(() => readVersionRunIdentity({ ...context, ...mutation }), /only the existing/u);}
});

test('live run binding rejects stale main and completed foreign or mismatched runs', () => {
  const identity = { sha, runId: 123, attempt: 1 };
  const run = { id: 123, run_attempt: 1, event: 'push', head_branch: 'main', head_sha: sha, path: '.github/workflows/release.yml', status: 'in_progress', conclusion: null, repository: { full_name: repository }, head_repository: { full_name: repository }, pull_requests: [], html_url: `https://github.com/${repository}/actions/runs/123` };
  const main = { ref: 'refs/heads/main', object: { type: 'commit', sha } };
  for (const mutation of [{ status: 'completed' }, { conclusion: 'success' }, { run_attempt: 2 }, { head_sha: 'b'.repeat(40) }, { path: '.github/workflows/ci.yml' }, { head_branch: 'changeset-release/main' }, { event: 'workflow_dispatch' }, { head_repository: { full_name: 'fork/repo' } }, { pull_requests: [{ number: 1 }] }]) {assert.throws(() => assertVersionRunBinding(identity, { ...run, ...mutation }, main), /observed release run/u);}
  assert.throws(() => assertVersionRunBinding(identity, run, { ...main, object: { type: 'commit', sha: 'b'.repeat(40) } }), /fresh main/u);
  assert.throws(() => assertVersionRunBinding(identity, {}, main), /observed JSON object/u);
});

test('version file inspection preserves metadata-only release admission', () => {
  const files = parseVersionFileChanges('M\0packages/engineering-foundation/package.json\0M\0packages/engineering-foundation/CHANGELOG.md\0D\0.changeset/native-toolchain.md\0');
  assert.doesNotThrow(() => assertVersionFiles(files, false));
  for (const filename of ['scripts/tool.ts', 'architecture/decisions/accepted-decisions.json', 'architecture/contracts/family/v1.json', 'architecture/public-api/engineering-foundation.artifacts.json']) {assert.throws(() => assertVersionFiles([...files, { filename, status: 'modified' }], false), /forbidden|nonmigration/u);}
  assert.throws(() => assertVersionFiles(files.filter(file => !file.filename.endsWith('CHANGELOG.md')), false), /CHANGELOG/u);
  assert.throws(() => assertVersionFiles(files.map(file => file.status === 'removed' ? { ...file, status: 'added' } : file), false), /forbidden|consume/u);
  assert.doesNotThrow(() => assertVersionFiles([...files, { filename: 'architecture/public-api/engineering-foundation.json', status: 'modified' }], false));
  for (const raw of ['M\0file', 'R100\0old\0new\0', 'U\0file\0']) {assert.throws(() => parseVersionFileChanges(raw), /malformed|unsupported/u);}
});

test('version metadata cannot change between preparation and application', () => {
  assert.throws(() => assertVersionSnapshotUnchanged('sha256:before', 'sha256:after'), /changed during/u);
});

test('working B binding rejects version-only content anchor and inventory drift in real files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-working-b-'));
  const policy: PublicApiCompatibilityPolicy = { schemaVersion: 1, changesetDirectory: '.changeset', acceptedDecisionBaselinePath: 'architecture/decisions/accepted-decisions.json', packages: nativeMigrationPackageNames.map(packageName => {
    const name = packageName.split('/').at(-1)!;
    return { packageName, packageRoot: `packages/${name}`, manifestPath: `packages/${name}/package.json`, tsconfigPath: `packages/${name}/tsconfig.json`, releasedBaselinePath: `architecture/public-api/${name}.json`, entrypoints: [], nonTypeExports: [], approvedBreakingChanges: [] };
  }) };
  const hash = migrationDigest(Buffer.from('fixture'));
  const review: NativeMigrationReview = { kind: 'foundation:public-api-native-migration:review:1', from: '7.58.12', to: 'typescript-native/7.0.2', baselineSourceCommit: sha, policyDigest: hash, toolDiffDigest: hash, packages: policy.packages.map(p => ({ packageName: p.packageName, baselinePath: p.releasedBaselinePath, baselineDigest: migrationDigest(workingBaselineBytes(p.packageName)), archiveDigest: hash, archiveIntegrity: 'fixture', configDigest: hash, releasedInputsDigest: hash, nativeReleasedDigest: hash })) };
  const input = { consumerRoot: root, policy, review };
  try {
    for (const p of policy.packages) { await mkdir(dirname(join(root, p.releasedBaselinePath)), { recursive: true }); await writeFile(join(root, p.releasedBaselinePath), workingBaselineBytes(p.packageName)); }
    await assertWorkingMigrationBaselines(input);
    const last = policy.packages.at(-1)!; const path = join(root, last.releasedBaselinePath);
    await writeFile(path, workingBaselineBytes(last.packageName, '1.10.0'));
    await assert.rejects(assertWorkingMigrationBaselines(input), /exact reviewed B bytes/u);
    await writeFile(path, Buffer.concat([workingBaselineBytes(last.packageName), Buffer.from(' ')]));
    await assert.rejects(assertWorkingMigrationBaselines(input), /exact reviewed B bytes/u);
    await writeFile(path, workingBaselineBytes(last.packageName));
    await assertWorkingMigrationBaselines(input);
    await assert.rejects(assertWorkingMigrationBaselines({ ...input, review: { ...review, packages: review.packages.map((p, i) => i === 0 ? { ...p, baselinePath: 'architecture/public-api/other.json' } : p) } }), /anchor/u);
    await assert.rejects(assertWorkingMigrationBaselines({ ...input, policy: { ...policy, packages: policy.packages.slice(1) } }), /closed eight/u);
    await assert.rejects(assertWorkingMigrationBaselines({ ...input, review: { ...review, packages: [...review.packages.slice(1), review.packages[1]!] } }), /closed eight/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
