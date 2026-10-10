import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  runCiInputProofAdapter,
  type FoundationPilotRequest,
  type Observation,
  type ScopeCategory,
} from '../../../scripts/ci-input-proof-foundation-adapter.mts';
import { executeFixedFull } from '../../../scripts/ci-input-proof-full.mts';
import {
  collectFoundationPilotObservation,
  foundationPilotRequest,
} from '../../../scripts/ci-input-proof-foundation-pilot.mts';
import { cases } from '../../support/ci-input-proof-donor-cases.mts';
import { compareLeafInventories } from '../../../packages/ci-input-proof/dist/index.js';
import type { InputLeaf, RejectionReason } from '../../../packages/ci-input-proof/dist/index.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const fixtureTimeoutMs = 1_000;

const waitForFixtureFile = async (path: string): Promise<string> => {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Fixture readiness file was not published: ${path}`);
    }
    await new Promise(resolve => {
      setTimeout(resolve, 10);
    });
  }
};

const killRecordedPid = (pid: number): void => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
};

const oldDigest = '1'.repeat(40);
const newDigest = '2'.repeat(40);
const sparse = (length: number): unknown[] => {
  const array: unknown[] = [];
  array.length = length;
  return array;
};
const leaf = (path: string, membership: 'closed' | 'structural' = 'closed', content = oldDigest): Extract<InputLeaf, { type: 'file' }> =>
  ({ path, type: 'file', mode: '100644', membership, content });
const inventory = (inputs: unknown = [leaf('package.json'), leaf('src/a.ts', 'structural')], scheme = 'git-object-sha1') =>
  ({ version: 1, digestScheme: scheme, inputs });
const rejected = (before: unknown, after: unknown, permission: unknown, reason: RejectionReason): void => {
  assert.deepEqual(compareLeafInventories(before, after, permission), { status: 'rejected', reason });
};
const scopeCategories: readonly ScopeCategory[] = [
  'source', 'helpers', 'fixtures', 'config', 'lock', 'toolchain', 'installedGraph',
];
const adapterLeaf = (category: ScopeCategory, content = '1'.repeat(64), membership: 'closed' | 'structural' = 'closed'): InputLeaf =>
  ({ path: `${category}/input.ts`, type: 'file', mode: '100644', membership, content });
const adapterObservation = (
  boundaryId: string,
  inputs: readonly InputLeaf[] = scopeCategories.map(category => adapterLeaf(category)),
  scope: Readonly<Record<ScopeCategory, readonly string[]>> = Object.freeze({
    source: Object.freeze(['source/input.ts']),
    helpers: Object.freeze(['helpers/input.ts']),
    fixtures: Object.freeze(['fixtures/input.ts']),
    config: Object.freeze(['config/input.ts']),
    lock: Object.freeze(['lock/input.ts']),
    toolchain: Object.freeze(['toolchain/input.ts']),
    installedGraph: Object.freeze(['installedGraph/input.ts']),
  }),
): Observation => Object.freeze({
  schemaVersion: 1,
  boundaryId,
  scopeId: 'foundation.ci-input-proof.focus.v1',
  scope,
  inventory: Object.freeze({ version: 1, digestScheme: 'sha256', inputs }),
});
const adapterRequest = (
  current: Observation,
  fullArgs: readonly string[] = ['-e', 'process.stdout.write("FULL-PASS")'],
): FoundationPilotRequest => Object.freeze({
  schemaVersion: 1,
  pilotId: 'foundation.ci-input-proof.focus.v1',
  tuple: Object.freeze({
    headSha: '1'.repeat(40),
    baseSha: '2'.repeat(40),
    mergeTuple: 'refs/heads/TEST-ci-input-proof',
  }),
  before: adapterObservation('before'),
  current,
  permittedContentChanges: Object.freeze([]),
  full: Object.freeze({
    command: process.execPath,
    args: fullArgs,
    cwd: resolve(process.cwd()),
    timeoutMs: 30_000,
  }),
});

async function copyCollectorScope(
  sourceRoot: string,
  destinationRoot: string,
  scope: Observation['scope'],
): Promise<void> {
  for (const paths of Object.values(scope)) {
    for (const logicalPath of paths) {
      if (logicalPath.startsWith('toolchain/')) {
        continue;
      }
      const destination = resolve(destinationRoot, logicalPath);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(resolve(sourceRoot, logicalPath), destination);
    }
  }
}


// Independent common cases also execute against each real donor in TEST checkouts.
// Failure: a shared fixture's advertised relation diverges from package behavior.
void test('versioned real-donor corpus keeps its independently expected leaf relations', () => {
  for (const entry of cases) {
    const inputs: InputLeaf[] = [leaf('package.json'), leaf('src/a.ts', 'structural')];
    switch (entry.id) {
      case 'same': break;
      case 'body-content': inputs[1] = leaf('src/a.ts', 'structural', newDigest); break;
      case 'closed-content': inputs[0] = leaf('package.json', 'closed', newDigest); break;
      case 'chmod': inputs[1] = { ...leaf('src/a.ts', 'structural'), mode: '100755' }; break;
      case 'addition': inputs.push(leaf('src/extra.ts')); break;
      case 'deletion': inputs.pop(); break;
      case 'rename': inputs[1] = leaf('src/b.ts', 'structural'); break;
    }
    const result = compareLeafInventories(inventory(), inventory(inputs), ['src/a.ts']);
    assert.equal(result.status === 'compatible-inputs', entry.compatible, entry.id);
    if (result.status === 'compatible-inputs') {
      assert.deepEqual(result.changedContentPaths, entry.id === 'body-content' ? ['src/a.ts'] : []);
    }
  }
});

void test('permutation is compatible; only actual permitted changes are reported in ordinal order', () => {
  const before = inventory([leaf('package.json'), leaf('src/z.ts', 'structural'), leaf('src/a.ts', 'structural')]);
  const after = inventory([leaf('src/a.ts', 'structural', newDigest), leaf('src/z.ts', 'structural', newDigest), leaf('package.json')]);
  assert.deepEqual(compareLeafInventories(before, after, ['src/z.ts', 'src/a.ts']),
    { status: 'compatible-inputs', changedContentPaths: ['src/a.ts', 'src/z.ts'] });
  assert.deepEqual(compareLeafInventories(before, before, ['src/z.ts']),
    { status: 'compatible-inputs', changedContentPaths: [] });
});

void test('closed drift and unpermitted structural drift reject; permissions never grant closed changes', () => {
  rejected(inventory(), inventory([leaf('package.json', 'closed', newDigest), leaf('src/a.ts', 'structural')]), [], 'closed-input-changed');
  rejected(inventory(), inventory([leaf('package.json'), leaf('src/a.ts', 'structural', newDigest)]), [], 'closed-input-changed');
  for (const permissions of [['package.json'], ['missing.ts'], ['src/a.ts', 'src/a.ts'], [1]]) {
    rejected(inventory(), inventory(), permissions, 'invalid-content-permission');
  }
});

void test('rename, addition, deletion, chmod, type and membership changes reject even with equal content', () => {
  const original = leaf('src/a.ts', 'structural');
  for (const inputs of [
    [leaf('package.json'), leaf('src/b.ts', 'structural')],
    [leaf('package.json')],
    [leaf('package.json'), original, leaf('extra.ts')],
    [leaf('package.json'), { ...original, mode: '100755' }],
    [leaf('package.json'), { ...original, type: 'symlink', mode: '120000' }],
    [leaf('package.json'), { ...original, membership: 'closed' }],
  ]) { rejected(inventory(), inventory(inputs), [], 'input-structure-changed'); }
});

void test('original getters and custom array iterators are rejected without executing them', () => {
  let effects = 0;
  const getter = () => { effects += 1; throw new Error('must not execute'); };
  for (const bad of [
    Object.defineProperty(inventory(), 'inputs', { get: getter }),
    inventory([Object.defineProperty(leaf('package.json'), 'content', { get: getter })]),
    inventory(Object.defineProperty([leaf('package.json')], Symbol.iterator, { value: getter })),
    inventory(Object.defineProperty([leaf('package.json')], '0', { get: getter })),
  ]) { rejected(bad, inventory(), [], 'malformed-inventory'); }
  rejected(inventory(), inventory(), Object.defineProperty(['src/a.ts'], Symbol.iterator, { value: getter }), 'invalid-content-permission');
  assert.equal(effects, 0);
});

void test('extra own fields, symbols, holes and unsupported prototypes cannot disappear during projection', () => {
  for (const bad of [
    { ...inventory(), extra: true },
    { ...inventory(), [Symbol('extra')]: true },
    inventory([{ ...leaf('package.json'), extra: true }]),
    inventory(sparse(1)),
    inventory(Object.assign([leaf('package.json')], { extra: true })),
    Object.setPrototypeOf(inventory(), { inherited: true }),
    inventory([Object.setPrototypeOf(leaf('package.json'), { inherited: true })]),
    inventory(Object.setPrototypeOf([leaf('package.json')], null)),
  ]) { rejected(bad, inventory(), [], 'malformed-inventory'); }
  const plain: unknown = Object.assign(Object.create(null), inventory([Object.assign(Object.create(null), leaf('package.json'))]));
  assert.deepEqual(compareLeafInventories(plain, inventory([leaf('package.json')]), []),
    { status: 'compatible-inputs', changedContentPaths: [] });
});

void test('empty/unclosed inventories and duplicate paths cannot qualify', () => {
  rejected(inventory([]), inventory(), [], 'incomplete-inputs');
  rejected(inventory([leaf('src/a.ts', 'structural')]), inventory(), [], 'incomplete-inputs');
  rejected(inventory([leaf('package.json'), leaf('package.json')]), inventory(), [], 'duplicate-input');
});

void test('literal paths reject ambiguous/absolute forms and retain case and Unicode identity', () => {
  for (const path of ['', '/a', 'C:/a', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a\u0000b', 'a\u007fb', 'a/']) {
    rejected(inventory([leaf(path)]), inventory(), [], 'malformed-inventory');
  }
  for (const [before, after] of [['A.ts', 'a.ts'], ['é.ts', 'e\u0301.ts']]) {
    rejected(inventory([leaf(before)]), inventory([leaf(after)]), [], 'input-structure-changed');
  }
});

void test('schemes, canonical nonzero digests and type/mode pairings are checked', () => {
  rejected({ ...inventory(), version: 2 }, inventory(), [], 'unsupported-version');
  rejected(inventory(undefined, 'unknown'), inventory(), [], 'unsupported-scheme');
  rejected(inventory([leaf('package.json')]), inventory([leaf('package.json', 'closed', '1'.repeat(64))], 'sha256'), [], 'scheme-mismatch');
  for (const content of ['0'.repeat(40), 'A'.repeat(40), '1'.repeat(64), '1'.repeat(39)]) {
    rejected(inventory([leaf('package.json', 'closed', content)]), inventory(), [], 'malformed-inventory');
  }
  rejected(inventory([{ ...leaf('package.json'), mode: '120000' }]), inventory(), [], 'malformed-inventory');
  for (const input of [{ ...leaf('a'), type: 'symlink', mode: '120000' }, { ...leaf('a'), type: 'gitlink', mode: '160000' }]) {
    assert.deepEqual(compareLeafInventories(inventory([input]), inventory([input]), []),
      { status: 'compatible-inputs', changedContentPaths: [] });
  }
});

void test('bounds reject before copying over-limit collections', () => {
  rejected(inventory(sparse(65_537)), inventory(), [], 'exceeded-limit');
  rejected(inventory([leaf('a'.repeat(4097))]), inventory(), [], 'exceeded-limit');
  rejected(inventory(), inventory(), sparse(3), 'exceeded-limit');
  const atLimit = inventory([leaf('a'.repeat(4096))]);
  assert.deepEqual(compareLeafInventories(atLimit, atLimit, []),
    { status: 'compatible-inputs', changedContentPaths: [] });
});

void test('result owns immutable values; caller mutation cannot alter an earlier relation', () => {
  const before = inventory();
  const callerLeaves = [leaf('package.json'), leaf('src/a.ts', 'structural', newDigest)];
  const after = inventory(callerLeaves);
  const permissions = ['src/a.ts'];
  const result = compareLeafInventories(before, after, permissions);
  callerLeaves[1] = leaf('other.ts');
  permissions[0] = 'other.ts';
  assert.deepEqual(result, { status: 'compatible-inputs', changedContentPaths: ['src/a.ts'] });
  assert.ok(Object.isFrozen(result));
  if (result.status === 'compatible-inputs') { assert.ok(Object.isFrozen(result.changedContentPaths)); }
});

void test('positive adapter case executes a real passing FULL process', async () => {
  const result = await runCiInputProofAdapter(adapterRequest(adapterObservation('current')), compareLeafInventories);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.execution.status, 'passed');
  assert.equal(result.report.execution.full.exitCode, 0);
  assert.equal(result.report.tuple.headSha, '1'.repeat(40));
  assert.match(result.report.tuple.digest, /^[a-f0-9]{64}$/u);
  assert.equal(result.report.candidateOmitObservation.status, 'eligible');
  assert.deepEqual(result.report.candidateOmitObservation.changedContentPaths, []);
  assert.deepEqual(result.report.omission, {
    status: 'not-attempted',
    reason: 'shadow-executes-full',
    reportedSeparatelyFromPass: true,
  });
  assert.deepEqual(result.report.selection, {
    decision: 'full',
    reason: 'shadow-no-admitted-omission-policy',
    independentlyExecutable: true,
  });
  assert.deepEqual(result.report.authority, {
    mode: 'control-shadow',
    admittedOmissionPolicy: false,
    packageResolutionClosure: 'unsupported',
    savedCheck: false,
  });
  assert.deepEqual(result.report.optimizer, {
    status: 'unavailable',
    reason: 'no-admitted-optimizer-policy',
    omissionAuthority: false,
  });
});

void test('fixed pilot closure rejects a real minor-to-patch changeset mutation', async () => {
  const temporaryRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ci-input-proof-closure-TEST-'));
  const changesetPath = '.changeset/ci-input-proof-kernel.md';
  const tuple = Object.freeze({
    headSha: '5'.repeat(40),
    baseSha: '6'.repeat(40),
    mergeTuple: 'refs/heads/TEST-ci-input-proof-closure',
  });
  try {
    const sourceCollection = await collectFoundationPilotObservation(repositoryRoot, 'source-scope');
    await copyCollectorScope(repositoryRoot, temporaryRoot, sourceCollection.observation.scope);
    const before = await collectFoundationPilotObservation(temporaryRoot, 'minor-before');
    assert.ok(before.observation.scope.config.includes(changesetPath));
    const beforeLeaf = before.observation.inventory.inputs.find(input => input.path === changesetPath);
    assert.ok(beforeLeaf);
    assert.equal(beforeLeaf.membership, 'closed');

    const sourceChangeset = await readFile(resolve(temporaryRoot, changesetPath), 'utf8');
    const mutatedChangeset = sourceChangeset.replace(
      '"@agent-teams/ci-input-proof": minor',
      '"@agent-teams/ci-input-proof": patch',
    );
    assert.notEqual(mutatedChangeset, sourceChangeset);
    await writeFile(resolve(temporaryRoot, changesetPath), mutatedChangeset, 'utf8');

    const current = await collectFoundationPilotObservation(temporaryRoot, 'patch-current');
    const currentLeaf = current.observation.inventory.inputs.find(input => input.path === changesetPath);
    assert.ok(currentLeaf);
    assert.notEqual(currentLeaf.content, beforeLeaf.content);
    assert.deepEqual(
      compareLeafInventories(before.observation.inventory, current.observation.inventory, []),
      { status: 'rejected', reason: 'closed-input-changed' },
    );

    const fixedRequest = foundationPilotRequest(before.observation, current.observation, tuple);
    assert.deepEqual(fixedRequest.full, {
      command: process.execPath,
      args: ['--test', 'tests/ci-input-proof-rc.test.mts'],
      cwd: repositoryRoot,
      timeoutMs: 180_000,
    });
    const focusedRequest = {
      ...fixedRequest,
      full: Object.freeze({
        command: process.execPath,
        args: Object.freeze(['-e', 'process.exit(0)']),
        cwd: temporaryRoot,
        timeoutMs: 30_000,
      }),
    };
    const adapter = await runCiInputProofAdapter(focusedRequest, compareLeafInventories);
    assert.equal(adapter.exitCode, 0);
    assert.equal(adapter.report.execution.status, 'passed');
    assert.deepEqual(adapter.report.candidateOmitObservation, {
      status: 'not-eligible',
      reason: 'input-proof-rejected:closed-input-changed',
      relation: { status: 'rejected', reason: 'closed-input-changed' },
      observationIssues: [],
      changedContentPaths: [],
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

// This isolated route check is not native Windows process-containment evidence.
void test('Linux-only pilot rejects unsupported platforms before collection or FULL', async () => {
  const temporaryRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ci-input-proof-platform-TEST-'));
  try {
    for (const platform of ['darwin', 'win32']) {
      const marker = resolve(temporaryRoot, `${platform}-full-marker`);
      const preload = resolve(temporaryRoot, `${platform}-platform.mjs`);
      const target = resolve(temporaryRoot, 'tests', 'ci-input-proof-rc.test.mts');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        preload,
        `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });\n`,
        'utf8',
      );
      await writeFile(
        target,
        'import { writeFile } from "node:fs/promises";\n'
          + 'import test from "node:test";\n'
          + `test("FULL must not run", async () => writeFile(${JSON.stringify(marker)}, "executed"));\n`,
        'utf8',
      );
      await assert.rejects(
        execFileAsync(process.execPath, [
          '--import', preload,
          resolve(repositoryRoot, 'scripts', 'ci-input-proof-foundation-pilot.mts'),
          '--head', '7'.repeat(40),
          '--base', '8'.repeat(40),
          '--merge', 'refs/heads/TEST-ci-input-proof-platform',
        ], { cwd: temporaryRoot }),
        (error: unknown) => {
          const childError = error as NodeJS.ErrnoException & { stdout: string; stderr: string };
          assert.equal(childError.code, 1);
          assert.equal(childError.stdout, '');
          assert.match(childError.stderr, new RegExp(`unsupported pilot platform ${platform}; Foundation pilot requires Linux`, 'u'));
          return true;
        },
      );
      await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

void test('closed and structural drift stay independently executable FULL without omission', async () => {
  const closedCurrent = adapterObservation('closed-current', scopeCategories.map(category =>
    adapterLeaf(category, category === 'source' ? '2'.repeat(64) : '1'.repeat(64))));
  const closed = await runCiInputProofAdapter(adapterRequest(closedCurrent), compareLeafInventories);
  assert.equal(closed.exitCode, 0);
  assert.equal(closed.report.execution.status, 'passed');
  assert.equal(closed.report.candidateOmitObservation.status, 'not-eligible');
  assert.equal(closed.report.candidateOmitObservation.reason, 'input-proof-rejected:closed-input-changed');

  const structuralInputs = scopeCategories.map(category =>
    adapterLeaf(category, category === 'fixtures' ? '3'.repeat(64) : '1'.repeat(64), category === 'fixtures' ? 'structural' : 'closed'));
  const structuralBeforeInputs = scopeCategories.map(category =>
    adapterLeaf(category, '1'.repeat(64), category === 'fixtures' ? 'structural' : 'closed'));
  const structuralCurrent = adapterObservation('structural-current', structuralInputs);
  const structuralRequest = adapterRequest(structuralCurrent);
  const structural = await runCiInputProofAdapter({
    ...structuralRequest,
    before: adapterObservation('structural-before', structuralBeforeInputs),
    permittedContentChanges: ['fixtures/input.ts'],
  }, compareLeafInventories);
  assert.equal(structural.exitCode, 0);
  assert.equal(structural.report.execution.status, 'passed');
  assert.equal(structural.report.candidateOmitObservation.status, 'not-eligible');
  assert.equal(structural.report.candidateOmitObservation.reason, 'structural-drift:fixtures/input.ts');
  assert.equal(structural.report.omission.status, 'not-attempted');
});

void test('scope or boundary drift remains independently executable FULL', async () => {
  const beforeScope = adapterObservation('before').scope;
  const swappedScope = Object.freeze({
    ...beforeScope,
    source: beforeScope.helpers,
    helpers: beforeScope.source,
  });
  const scopeDrift = await runCiInputProofAdapter(
    adapterRequest(adapterObservation('scope-current', undefined, swappedScope)),
    compareLeafInventories,
  );
  assert.equal(scopeDrift.exitCode, 0);
  assert.equal(scopeDrift.report.execution.status, 'passed');
  assert.equal(scopeDrift.report.candidateOmitObservation.status, 'not-eligible');
  assert.match(scopeDrift.report.candidateOmitObservation.reason, /observation:scope-drift/u);
  assert.equal(scopeDrift.report.selection.decision, 'full');

  const duplicateBoundary = await runCiInputProofAdapter({
    ...adapterRequest(adapterObservation('same-boundary')),
    before: adapterObservation('same-boundary'),
  }, compareLeafInventories);
  assert.equal(duplicateBoundary.exitCode, 0);
  assert.equal(duplicateBoundary.report.execution.status, 'passed');
  assert.match(duplicateBoundary.report.candidateOmitObservation.reason, /observation:boundary-not-distinct/u);
});

void test('incomplete closure and failed FULL remain fail closed in real processes', async () => {
  const incompleteScope = Object.freeze({
    ...adapterObservation('current').scope,
    source: Object.freeze([]),
  }) as Readonly<Record<ScopeCategory, readonly string[]>>;
  const incomplete = await runCiInputProofAdapter(
    adapterRequest(adapterObservation('incomplete-current', undefined, incompleteScope)),
    compareLeafInventories,
  );
  assert.equal(incomplete.exitCode, 0);
  assert.equal(incomplete.report.execution.status, 'passed');
  assert.match(incomplete.report.candidateOmitObservation.reason, /^incomplete-observation:/u);

  const unsupported = await runCiInputProofAdapter(
    adapterRequest({ ...adapterObservation('unsupported-current'), schemaVersion: 2 as 1 }),
    compareLeafInventories,
  );
  assert.equal(unsupported.exitCode, 0);
  assert.equal(unsupported.report.execution.status, 'passed');
  assert.match(unsupported.report.candidateOmitObservation.reason, /unsupported-schema/u);
  assert.equal(unsupported.report.omission.status, 'not-attempted');

  const failed = await runCiInputProofAdapter(
    adapterRequest(
      adapterObservation('failed-current'),
      ['-e', 'process.stdout.write("FULL-PASS"); process.exit(23)'],
    ),
    compareLeafInventories,
  );
  assert.equal(failed.exitCode, 23);
  assert.equal(failed.report.execution.status, 'failed');
  assert.equal(failed.report.execution.full.exitCode, 23);
  assert.equal(failed.report.optimizer.status, 'unavailable');
  assert.equal(failed.report.omission.status, 'not-attempted');
});

void test('plain FULL bounds newline-free output without an stdout verdict', async () => {
  const result = await executeFixedFull({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("x".repeat(65537))'],
    cwd: resolve(process.cwd()),
    timeoutMs: 5_000,
  });
  assert.equal(result.report.status, 'passed');
  assert.equal(result.report.exitCode, 0);
  assert.equal(result.report.outputTruncated, true);
  assert.equal(result.stdout.length, 64 * 1024);
});

void test('signal termination and timeout exit zero never produce adapter PASS', async () => {
  const signalled = await runCiInputProofAdapter(
    adapterRequest(
      adapterObservation('signal-current'),
      ['-e', 'process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 1000);'],
    ),
    compareLeafInventories,
  );
  assert.notEqual(signalled.exitCode, 0);
  assert.equal(signalled.report.execution.status, 'failed');
  if (process.platform === 'win32') {
    assert.notEqual(signalled.report.execution.full.exitCode, 0);
    assert.ok(['process-failed', 'process-signal'].includes(signalled.report.execution.full.reason ?? ''));
  } else {
    assert.equal(signalled.report.execution.full.exitCode, null);
    assert.equal(signalled.report.execution.full.signal, 'SIGTERM');
    assert.equal(signalled.report.execution.full.reason, 'process-signal');
  }

  const timeoutReadyPath = resolve(process.cwd(), 'timeout-handler-ready-TEST');
  const timeoutRequest = adapterRequest(
    adapterObservation('timeout-current'),
    [
      '-e',
      'const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => setTimeout(() => process.exit(0), 5)); writeFileSync(process.argv[1], "ready"); setTimeout(() => {}, 5000);',
      timeoutReadyPath,
    ],
  );
  const timedOut = await runCiInputProofAdapter({
    ...timeoutRequest,
    full: Object.freeze({ ...timeoutRequest.full, timeoutMs: fixtureTimeoutMs }),
  }, compareLeafInventories);
  assert.equal(await waitForFixtureFile(timeoutReadyPath), 'ready');
  assert.notEqual(timedOut.exitCode, 0);
  assert.equal(timedOut.report.execution.status, 'failed');
  assert.equal(timedOut.report.execution.full.reason, 'process-timeout');
  assert.ok(timedOut.report.timingsMs.full >= fixtureTimeoutMs - 25);
  assert.ok(timedOut.report.timingsMs.full < fixtureTimeoutMs + 5_000);
  if (process.platform !== 'win32') {
    assert.equal(timedOut.report.execution.full.exitCode, 0);
    assert.equal(timedOut.report.execution.full.signal, null);
  }

  const escalationReadyPath = resolve(process.cwd(), 'escalation-handler-ready-TEST');
  const escalationRequest = adapterRequest(
    adapterObservation('escalation-current'),
    [
      '-e',
      'const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); writeFileSync(process.argv[1], "ready"); setTimeout(() => {}, 5000);',
      escalationReadyPath,
    ],
  );
  const escalated = await runCiInputProofAdapter({
    ...escalationRequest,
    full: Object.freeze({ ...escalationRequest.full, timeoutMs: fixtureTimeoutMs }),
  }, compareLeafInventories);
  assert.equal(await waitForFixtureFile(escalationReadyPath), 'ready');
  assert.notEqual(escalated.exitCode, 0);
  assert.equal(escalated.report.execution.status, 'failed');
  assert.equal(escalated.report.execution.full.reason, 'process-timeout');
  assert.ok(escalated.report.timingsMs.full >= fixtureTimeoutMs - 25);
  assert.ok(escalated.report.timingsMs.full < fixtureTimeoutMs + 5_000);
  if (process.platform !== 'win32') {
    assert.equal(escalated.report.execution.full.signal, 'SIGKILL');
  }
});

void test('timeout cleans an inherited descendant process tree', async () => {
  const temporaryRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ci-input-proof-descendant-TEST-'));
  let descendantPid: number | null = null;
  try {
    const pidPath = join(temporaryRoot, 'descendant-pid');
    const descendantReadyPath = join(temporaryRoot, 'descendant-ready');
    const descendantScript = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.execPath, [\'-e\', \'const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); writeFileSync(process.argv[1], "ready"); setInterval(() => {}, 1000);\', process.argv[2]], { stdio: ["ignore", 1, 2] });',
      'writeFileSync(process.argv[1], String(child.pid));',
      'setInterval(() => {}, 1000);',
    ].join('');
    const timeoutRequest = adapterRequest(
      adapterObservation('descendant-timeout-current'),
      ['-e', descendantScript, pidPath, descendantReadyPath],
    );
    const result = await runCiInputProofAdapter({
      ...timeoutRequest,
      full: Object.freeze({ ...timeoutRequest.full, timeoutMs: fixtureTimeoutMs }),
    }, compareLeafInventories);
    assert.equal(await waitForFixtureFile(descendantReadyPath), 'ready');
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.report.execution.status, 'failed');
    assert.equal(result.report.execution.full.reason, 'process-timeout');
    descendantPid = Number(await waitForFixtureFile(pidPath));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    let descendantPresent = true;
    try {
      process.kill(descendantPid, 0);
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
      descendantPresent = false;
    }
    if (descendantPresent) {
      assert.equal(process.platform, 'linux', 'Inherited descendant remained live after timeout cleanup.');
      try {
        const processStat = readFileSync(`/proc/${String(descendantPid)}/stat`, 'utf8');
        const stateStart = processStat.lastIndexOf(') ');
        assert.ok(stateStart >= 0);
        assert.equal(processStat.slice(stateStart + 2).trim().split(/\s+/u)[0], 'Z');
        const descriptors = readdirSync(`/proc/${String(descendantPid)}/fd`);
        for (const descriptor of descriptors) {
          assert.doesNotMatch(
            readlinkSync(`/proc/${String(descendantPid)}/fd/${descriptor}`),
            /^pipe:\[/u,
          );
        }
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
      }
    }
  } finally {
    if (descendantPid !== null) {
      killRecordedPid(descendantPid);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

void test('inherited pipes settle boundedly and never conceal escaped descendants', async () => {
  const temporaryRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ci-input-proof-inherited-pipe-TEST-'));
  let escapedPid: number | null = null;
  try {
    const pidPath = join(temporaryRoot, 'escaped-pid');
    const escapedReadyPath = join(temporaryRoot, 'escaped-ready');
    const escapedScript = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.execPath, [\'-e\', \'const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); writeFileSync(process.argv[1], "ready"); setInterval(() => {}, 1000);\', process.argv[2]], { detached: true, stdio: ["ignore", 1, 2] });',
      'child.unref();',
      'writeFileSync(process.argv[1], String(child.pid));',
      'process.stdout.write("x".repeat(65537));',
      'process.stderr.write("x".repeat(65537));',
    ].join('');
    const started = Date.now();
    const result = await executeFixedFull({
      command: process.execPath,
      args: ['-e', escapedScript, pidPath, escapedReadyPath],
      cwd: temporaryRoot,
      timeoutMs: 5_000,
    });
    const elapsedMs = Date.now() - started;
    escapedPid = Number(await waitForFixtureFile(pidPath));
    assert.equal(await waitForFixtureFile(escapedReadyPath), 'ready');
    assert.ok(Number.isSafeInteger(escapedPid) && escapedPid > 0);
    assert.equal(result.report.exitCode, 0);
    assert.equal(result.report.outputTruncated, true);
    assert.equal(result.stdout.length, 64 * 1024);
    assert.ok(elapsedMs < 3_000);
    if (process.platform === 'win32') {
      assert.equal(result.report.status, 'passed');
      assert.equal(result.report.reason, null);
    } else {
      assert.equal(result.report.status, 'failed');
      assert.equal(result.report.errorCode, 'process-stream-settlement-timeout');
      assert.equal(result.report.reason, 'process-settlement-failed');
      process.kill(escapedPid, 0);
    }
  } finally {
    if (escapedPid !== null) {
      killRecordedPid(escapedPid);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

void test('collector and comparator import failure still execute independent FULL', async () => {
  const temporaryRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ci-input-proof-import-failure-TEST-'));
  try {
    await mkdir(join(temporaryRoot, 'scripts'), { recursive: true });
    await mkdir(join(temporaryRoot, 'tests', 'features', 'input-comparison'), { recursive: true });
    await copyFile(
      join(repositoryRoot, 'scripts', 'ci-input-proof-foundation-adapter.mts'),
      join(temporaryRoot, 'scripts', 'ci-input-proof-foundation-adapter.mts'),
    );
    await copyFile(
      join(repositoryRoot, 'scripts', 'ci-input-proof-full.mts'),
      join(temporaryRoot, 'scripts', 'ci-input-proof-full.mts'),
    );
    await copyFile(
      join(repositoryRoot, 'scripts', 'ci-input-proof-foundation-pilot.mts'),
      join(temporaryRoot, 'scripts', 'ci-input-proof-foundation-pilot.mts'),
    );
    await writeFile(
      join(temporaryRoot, 'tests', 'features', 'input-comparison', 'ci-input-proof.test.mts'),
      'import assert from "node:assert/strict";\nimport { test } from "node:test";\nvoid test("independent FULL", () => assert.equal(1, 1));\n',
      'utf8',
    );
    await writeFile(
      join(temporaryRoot, 'tests', 'ci-input-proof-rc.test.mts'),
      'import assert from "node:assert/strict";\nimport { test } from "node:test";\nvoid test("independent FULL", () => assert.equal(1, 1));\n',
      'utf8',
    );
    const child = await execFileAsync(process.execPath, [
      join(temporaryRoot, 'scripts', 'ci-input-proof-foundation-pilot.mts'),
      '--head', '3'.repeat(40),
      '--base', '4'.repeat(40),
      '--merge', 'refs/heads/TEST-ci-input-proof-import-failure',
    ], { cwd: temporaryRoot });
    const result = JSON.parse(child.stdout) as Readonly<{
      collectionIssues: readonly string[];
      adapter: Readonly<{
        exitCode: number;
        report: Readonly<{
          candidateOmitObservation: Readonly<{ status: string; reason: string }>;
          execution: Readonly<{ status: string }>;
          selection: Readonly<{ decision: string }>;
        }>;
      }>;
    }>;
    assert.match(result.collectionIssues.join(','), /(?:^|,)before:/u);
    assert.ok(result.collectionIssues.includes('comparator:import-unavailable'));
    assert.equal(result.adapter.exitCode, 0);
    assert.equal(result.adapter.report.execution.status, 'passed');
    assert.equal(result.adapter.report.candidateOmitObservation.status, 'not-eligible');
    assert.equal(result.adapter.report.selection.decision, 'full');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
