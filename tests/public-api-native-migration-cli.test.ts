import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { assertReportDestination, assertWorkingMigrationBaselines, nativeMigrationMain, ordinaryFailureResult, parseMigrationArguments, qualifyOrdinaryResult, writeReport } from '../scripts/public-api-native-migration-cli.ts';
import { capabilityReport, foundationReport } from '../packages/engineering-foundation/dist/features/validation-reporting/api.js';
import type { PublicApiCompatibilityPolicy } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/public-api.js';
import { migrationBytes, migrationDigest, type NativeMigrationReview } from '../scripts/public-api-native-migration.ts';
import { nativeMigrationPackageNames } from '../scripts/public-api-native-migration-observation.ts';
import { assertVersionFiles, assertVersionRunBinding, assertVersionSnapshotUnchanged, parseVersionFileChanges, readVersionRunIdentity, versionMetadataDigest } from '../scripts/public-api-native-migration-version.ts';
import { runCommand } from '../scripts/pack-test-support.mjs';
import { assertNativeMigrationOriginAudit, readNativeMigrationIntent } from '../scripts/public-api-native-migration-inputs.ts';
import { artifactProvenance, auditEvidence } from './support/release-publish-ordered-fixtures.mjs';
import { fileURLToPath } from 'node:url';

const sha = 'a'.repeat(40); const repository = 'agent-teams-ai/engineering-foundation';
const context = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_JOB: 'release', GITHUB_SERVER_URL: 'https://github.com', GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release.yml@refs/heads/main`, GITHUB_WORKFLOW_SHA: sha, GITHUB_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
const workingBaselineBytes = (name: string, version = '1.9.0') => migrationBytes({ packageName: name, packageVersion: version, extractorVersion: '7.58.12', entrypoints: [] });

void test('archive origin result binding requires the exact seven npm subjects, reviewed SRI and publication source', async () => {
  const intent = await readNativeMigrationIntent(fileURLToPath(new URL('..', import.meta.url)));
  const subjects = intent.origins.filter(origin => origin.publicationSourceCommit !== null).flatMap(origin => {
    const pin = intent.review.packages.find(row => row.packageName === origin.name)!;
    const artifact = { name: origin.name, version: origin.version, integrity: pin.archiveIntegrity };
    return auditEvidence(artifact, artifactProvenance(artifact, origin.publicationSourceCommit!)).verified;
  });
  const evidence = { invalid: [], missing: [], verified: subjects };
  assert.doesNotThrow(() => { assertNativeMigrationOriginAudit(evidence, intent); });
  for (const verified of [subjects.slice(1), [...subjects, subjects.at(0)!], [...subjects.slice(1), { ...subjects.at(0)!, name: '@agent-teams/unexpected' }], subjects.map((row, index) => index === 0 ? { ...row, version: '0.0.0' } : row)]) {
    assert.throws(() => { assertNativeMigrationOriginAudit({ ...evidence, verified }, intent); }, /exact seven/u);
  }
  for (const malformed of [null, {}, { ...evidence, invalid: [{}] }, { ...evidence, missing: [{}] }, { ...evidence, verified: [null] }]) {
    assert.throws(() => { assertNativeMigrationOriginAudit(malformed, intent); }, /object|array|clean/u);
  }
  const first = intent.review.packages.at(0)!;
  const wrongIntegrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  assert.throws(() => { assertNativeMigrationOriginAudit(evidence, { ...intent, review: { ...intent.review, packages: intent.review.packages.map(row => row === first ? { ...row, archiveIntegrity: wrongIntegrity } : row) } }); }, /not bound/u);
  assert.throws(() => { assertNativeMigrationOriginAudit(evidence, { ...intent, origins: intent.origins.map(origin => origin.name === first.packageName ? { ...origin, publicationSourceCommit: sha } : origin) }); }, /publication commit/u);
});

void test('driver exposes only the two closed modes and qualify report destinations', () => {
  assert.deepEqual(parseMigrationArguments(['qualify', '--ordinary-report', '/tmp/ordinary.json', '--migration-report', '/tmp/migration.json']), { mode: 'qualify', ordinaryReport: '/tmp/ordinary.json', migrationReport: '/tmp/migration.json' });
  assert.deepEqual(parseMigrationArguments(['apply-version']), { mode: 'apply-version' });
  for (const args of [[], ['migrate'], ['qualify', '--consumer', '/tmp/other'], ['qualify', '--approve'], ['qualify', '--ordinary-report'], ['qualify', '--ordinary-report', 'a', '--ordinary-report', 'b'], ['apply-version', '--migration-report', '/tmp/report']]) {assert.throws(() => parseMigrationArguments(args), /expected|unsupported/u);}
});

void test('report options cannot overwrite files within the source checkout', () => {
  const root = join(tmpdir(), 'fixed-foundation-checkout');
  for (const path of [root, join(root, 'architecture/public-api/engineering-foundation.json'), join(root, 'scripts/tool.ts')]) {assert.throws(() => assertReportDestination(root, path), /outside/u);}
  assert.equal(assertReportDestination(root, join(tmpdir(), 'native-ordinary.json')), join(tmpdir(), 'native-ordinary.json'));
});

void test('report parent aliases cannot create missing checkout directories or report files', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'native-report-parent-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const checkout = fileURLToPath(new URL('..', import.meta.url));
  const missing = join(checkout, basename(temporary));
  const alias = join(temporary, 'checkout');
  await symlink(checkout, alias, 'junction');
  await assert.rejects(lstat(missing), { code: 'ENOENT' });
  t.after(() => rm(missing, { recursive: true, force: true }));
  await assert.rejects(writeReport(join(alias, basename(temporary), 'report.json'), 'raw report\n'), { code: 'ENOENT' });
  await assert.rejects(lstat(missing), { code: 'ENOENT' });
  const filename = `${basename(temporary)}.json`;
  await assert.rejects(lstat(join(checkout, filename)), { code: 'ENOENT' });
  t.after(() => rm(join(checkout, filename), { force: true }));
  await assert.rejects(writeReport(join(alias, filename), 'raw report\n'), /outside/u);
  await assert.rejects(lstat(join(checkout, filename)), { code: 'ENOENT' });
});

void test('reports preserve raw bytes exclusively in an existing outside parent with private permissions', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'native-report-output-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = join(temporary, 'reports'); await mkdir(directory);
  const alias = join(temporary, 'alias'); await symlink(directory, alias, 'junction');
  const bytes = Buffer.from('raw report\r\n{"reason":"<untrusted>"}\n\0', 'utf8');
  const path = join(alias, 'report.json');
  await writeReport(path, bytes);
  assert.deepEqual(await readFile(join(directory, 'report.json')), bytes);
  await assert.rejects(writeReport(path, 'replacement'), { code: 'EEXIST' });
  assert.deepEqual(await readFile(path), bytes);
  const text = 'original stdout\r\n';
  await writeReport(join(directory, 'ordinary.json'), text);
  assert.equal(await readFile(join(directory, 'ordinary.json'), 'utf8'), text);
  if (process.platform !== 'win32') {assert.equal((await stat(path)).mode & 0o777, 0o600);}
  const absent = join(temporary, 'absent');
  await assert.rejects(writeReport(join(absent, 'report.json'), bytes), { code: 'ENOENT' });
  await assert.rejects(lstat(absent), { code: 'ENOENT' });
});

void test('ordinary failed child preserves complete stdout stderr and actual exit', async () => {
  let failure: unknown;
  try { await runCommand(process.execPath, ['--input-type=module', '-e', 'process.stdout.write("{\\"original\\":true}\\n"); process.stderr.write("retained stderr\\n"); process.exitCode=1;'], tmpdir()); }
  catch (error) { failure = error; }
  assert.deepEqual(ordinaryFailureResult(failure), { stdout: '{"original":true}\n', stderr: 'retained stderr\n', exitCode: 1 });
  assert.throws(() => ordinaryFailureResult(new Error('transport failure')), /transport failure/u);
  if (!(failure instanceof Error)) {assert.fail('expected managed child failure');}
  Object.assign(failure, { timedOut: true });
  assert.throws(() => ordinaryFailureResult(failure), /Command failed/u);
});

void test('ordinary nonmigration failures reject before any archive acquisition', async () => {
  const report = foundationReport({ foundationVersion: '1.8.0', coverage: 'full', capabilities: [capabilityReport({ capabilityId: 'repository.security-baseline', capabilityConfigSchemaVersion: 1, diagnostics: [{ ruleId: 'repository.security-baseline.dependency-review-missing', severity: 'error', subject: 'fixture', message: 'Missing dependency review', location: { path: '.github/workflows/ci.yml' }, relatedLocations: [], evidence: [], remediation: 'Restore dependency review', requiresArchitectureReview: false }] })] });
  let acquired = false;
  await assert.rejects(qualifyOrdinaryResult({ stdout: JSON.stringify(report), stderr: '', exitCode: 1 }, async () => { acquired = true; throw new Error('archive acquisition must not run'); }), /ordinary full report/u);
  assert.equal(acquired, false);
});

void test('ordinary passed report expires the migration without archive acquisition', async () => {
  const report = foundationReport({ foundationVersion: '1.8.0', coverage: 'full', capabilities: [capabilityReport({ capabilityId: 'repository.security-baseline', capabilityConfigSchemaVersion: 1 })] });
  const result = await qualifyOrdinaryResult({ stdout: JSON.stringify(report), stderr: '', exitCode: 0 }, async () => { throw new Error('archive acquisition must not run'); });
  assert.equal(result.outcome, 'ordinary-passed');
  assert.deepEqual(result.report, report);
});

void test('workstation apply refuses before any acquisition or baseline write', async () => {
  assert.throws(() => readVersionRunIdentity({}), /only the existing/u);
  if (process.env['GITHUB_ACTIONS'] !== 'true') {await assert.rejects(nativeMigrationMain(['apply-version']), /only the existing/u);}
});

void test('environment claims alone are insufficient and wrong release contexts reject', () => {
  for (const mutation of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'fork/engineering-foundation' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_JOB: 'test' }, { GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@refs/heads/main` }, { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) }, { GITHUB_RUN_ID: '00123' }, { GITHUB_RUN_ATTEMPT: '0' }]) {assert.throws(() => readVersionRunIdentity({ ...context, ...mutation }), /only the existing/u);}
});

void test('live run binding rejects stale main and completed foreign or mismatched runs', () => {
  const identity = { sha, runId: 123, attempt: 1 };
  const run = { id: 123, run_attempt: 1, event: 'push', head_branch: 'main', head_sha: sha, path: '.github/workflows/release.yml', status: 'in_progress', conclusion: null, repository: { full_name: repository }, head_repository: { full_name: repository }, pull_requests: [], html_url: `https://github.com/${repository}/actions/runs/123` };
  const main = { ref: 'refs/heads/main', object: { type: 'commit', sha } };
  const prefix = 'Native migration version workflow: observed release run or fresh main differs from the invocation; mismatched fields: ';
  assert.doesNotThrow(() => { assertVersionRunBinding(identity, run, main); });
  const runMutations: readonly [string, Record<string, unknown>][] = [
    ['run.id', { id: 124 }], ['run.run_attempt', { run_attempt: 2 }],
    ['run.event', { event: 'workflow_dispatch' }], ['run.head_branch', { head_branch: 'changeset-release/main' }],
    ['run.head_sha', { head_sha: 'b'.repeat(40) }], ['run.path', { path: '.github/workflows/ci.yml' }],
    ['run.status', { status: 'completed' }], ['run.status', { status: 'queued' }],
    ['run.conclusion', { conclusion: 'success' }],
    ['run.repository.full_name', { repository: { full_name: 'fork/repo' } }],
    ['run.head_repository.full_name', { head_repository: { full_name: 'fork/repo' } }],
    ['run.pull_requests', { pull_requests: [{ number: 1 }] }], ['run.pull_requests', { pull_requests: null }],
    ['run.html_url', { html_url: 'https://example.invalid/untrusted' }],
  ];
  for (const [field, mutation] of runMutations) {
    const status = typeof mutation['status'] === 'string' ? mutation['status'] : 'in_progress';
    const conclusion = typeof mutation['conclusion'] === 'string' ? mutation['conclusion'] : 'null';
    assert.throws(() => { assertVersionRunBinding(identity, { ...run, ...mutation }, main); }, {
      message: `${prefix}${field}; observed status: ${status}; observed conclusion: ${conclusion}`,
    });
  }
  for (const [field, mutation] of [
    ['main.ref', { ref: 'refs/heads/feature' }],
    ['main.object.type', { object: { type: 'tag', sha } }],
    ['main.object.sha', { object: { type: 'commit', sha: 'b'.repeat(40) } }],
  ] as const) {
    assert.throws(() => { assertVersionRunBinding(identity, run, { ...main, ...mutation }); }, {
      message: `${prefix}${field}; observed status: in_progress; observed conclusion: null`,
    });
  }
  assert.throws(() => { assertVersionRunBinding(identity, { ...run, id: 124, status: 'queued', conclusion: 'failure' },
    { ...main, object: { type: 'commit', sha: 'b'.repeat(40) } }); }, {
    message: `${prefix}run.id, run.status, run.conclusion, main.object.sha; observed status: queued; observed conclusion: failure`,
  });
  for (const unexpected of ['provider-value-must-not-leak\nsecret=fixture', '', undefined, 7, {}, []]) {
    assert.throws(() => { assertVersionRunBinding(identity, { ...run, status: unexpected, conclusion: unexpected }, main); }, {
      message: `${prefix}run.status, run.conclusion; observed status: unexpected; observed conclusion: unexpected`,
    });
  }
  for (const malformed of [{}, { ...run, repository: null }, { ...run, head_repository: [] }]) {
    assert.throws(() => { assertVersionRunBinding(identity, malformed, main); }, /observed JSON object/u);
  }
  assert.throws(() => { assertVersionRunBinding(identity, run, { ...main, object: null }); }, /observed JSON object/u);
});

void test('version file inspection preserves metadata-only release admission', () => {
  const files = parseVersionFileChanges('M\0packages/engineering-foundation/package.json\0M\0packages/engineering-foundation/CHANGELOG.md\0D\0.changeset/native-toolchain.md\0');
  assert.doesNotThrow(() => { assertVersionFiles(files, false); });
  for (const filename of ['scripts/tool.ts', 'architecture/decisions/accepted-decisions.json', 'architecture/contracts/family/v1.json', 'architecture/public-api/engineering-foundation.artifacts.json']) {assert.throws(() => { assertVersionFiles([...files, { filename, status: 'modified' }], false); }, /forbidden|nonmigration/u);}
  assert.throws(() => { assertVersionFiles(files.filter(file => !file.filename.endsWith('CHANGELOG.md')), false); }, /CHANGELOG/u);
  assert.throws(() => { assertVersionFiles(files.map(file => file.status === 'removed' ? { ...file, status: 'added' } : file), false); }, /forbidden|consume/u);
  assert.doesNotThrow(() => { assertVersionFiles([...files, { filename: 'architecture/public-api/engineering-foundation.json', status: 'modified' }], false); });
  for (const raw of ['M\0file', 'R100\0old\0new\0', 'U\0file\0']) {assert.throws(() => parseVersionFileChanges(raw), /malformed|unsupported/u);}
});

void test('version metadata cannot change between preparation and application', () => {
  assert.throws(() => { assertVersionSnapshotUnchanged('sha256:before', 'sha256:after'); }, /changed during/u);
});

void test('version metadata hashes the complete ordinary file and retains read-size and mode refusals', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-version-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'CHANGELOG.md');
  const bytes = Buffer.alloc(128 * 1024 + 3, 65);
  await writeFile(path, bytes, { mode: 0o600 });
  assert.equal(await versionMetadataDigest(path), migrationDigest(bytes));
  if (process.platform !== 'win32') {
    await chmod(path, 0o700);
    await assert.rejects(versionMetadataDigest(path), /ordinary nonexecutable files/u);
    await chmod(path, 0o600);
    // POSIX truncate creates the sparse refusal fixture without allocating
    // a multi-gigabyte file in the Windows test workspace.
    const file = await open(path, 'r+');
    try { await file.truncate(2 ** 31); } finally { await file.close(); }
    await assert.rejects(versionMetadataDigest(path), /existing file-read ceiling/u);
  }
});

void test('working B binding rejects version-only content anchor and inventory drift in real files', async () => {
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
    await assert.rejects(assertWorkingMigrationBaselines({ ...input, review: { ...review, packages: [...review.packages.slice(1), review.packages.at(1)!] } }), /closed eight/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
