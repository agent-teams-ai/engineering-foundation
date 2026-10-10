import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export const packedDeepImportSource = `// @ts-expect-error The public package root deliberately rejects deep imports.
import type { LeafInventory } from '@agent-teams/ci-input-proof/dist/index.js';
export type DeepImportMustReject = LeafInventory;
`;

export const packedRunnerSource = `
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { version as typescriptVersion, versionMajorMinor } from 'typescript';
import {
  compareLeafInventories,
  type InputLeaf,
  type LeafInventory,
} from '@agent-teams/ci-input-proof';
import {
  runCiInputProofAdapter,
  type FoundationPilotRequest,
  type Observation,
  type ScopeCategory,
} from './scripts/ci-input-proof-foundation-adapter.mts';
import { executeFixedFull } from './scripts/ci-input-proof-full.mts';
import { typedPublicApiReference } from './typed-public-api.TEST.mts';

assert.equal(typescriptVersion, '7.0.2');
assert.equal(versionMajorMinor, '7.0');

const categories: readonly ScopeCategory[] = [
  'source', 'helpers', 'fixtures', 'config', 'lock', 'toolchain', 'installedGraph',
];
const leaf = (
  category: ScopeCategory,
  content: string = '1'.repeat(64),
  membership: 'closed' | 'structural' = 'closed',
): InputLeaf => ({
  path: category + '/input.ts',
  type: 'file',
  mode: '100644',
  membership,
  content,
});
const observation = (
  boundaryId: string,
  inputs: readonly InputLeaf[] = categories.map(category => leaf(category)),
  scope: Readonly<Record<ScopeCategory, readonly string[]>> = Object.freeze(Object.fromEntries(
    categories.map(category => [category, Object.freeze([category + '/input.ts'])]),
  )) as Readonly<Record<ScopeCategory, readonly string[]>>,
): Observation => Object.freeze({
  schemaVersion: 1,
  boundaryId,
  scopeId: 'foundation.ci-input-proof.focus.v1',
  scope,
  inventory: Object.freeze({ version: 1, digestScheme: 'sha256', inputs }) satisfies LeafInventory,
});
const request = (
  current: Observation,
  fullArgs: readonly string[] = ['-e', 'process.stdout.write("PACKED-FULL-PASS")'],
  timeoutMs: number = 30_000,
): FoundationPilotRequest => Object.freeze({
  schemaVersion: 1,
  pilotId: 'foundation.ci-input-proof.focus.v1',
  tuple: Object.freeze({
    headSha: '1'.repeat(40),
    baseSha: '2'.repeat(40),
    mergeTuple: 'refs/heads/TEST-packed-ci-input-proof',
  }),
  before: observation('before'),
  current,
  permittedContentChanges: Object.freeze([]),
  full: Object.freeze({
    command: process.execPath,
    args: fullArgs,
    cwd: resolve(process.cwd()),
    timeoutMs,
  }),
});

const waitForFixtureFile = async (path: string): Promise<string> => {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error('Fixture readiness file was not published: ' + path);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

const killRecordedPid = (pid: number): void => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
};

assert.deepEqual(typedPublicApiReference(), {
  status: 'compatible-inputs',
  changedContentPaths: ['vendor/fixture'],
});

let deepImportCode: string | null = null;
try {
  await import('@agent-teams/ci-input-proof/' + 'dist/index.js');
} catch (error) {
  deepImportCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}
assert.equal(deepImportCode, 'ERR_PACKAGE_PATH_NOT_EXPORTED');

const positive = await runCiInputProofAdapter(request(observation('current')), compareLeafInventories);
assert.equal(positive.exitCode, 0);
assert.equal(positive.report.execution.status, 'passed');
assert.equal(positive.report.execution.full.exitCode, 0);
assert.equal(positive.report.candidateOmitObservation.status, 'eligible');
assert.equal(positive.report.omission.status, 'not-attempted');
assert.equal(positive.report.optimizer.status, 'unavailable');
assert.equal(positive.report.selection.decision, 'full');
assert.equal(positive.report.authority.mode, 'control-shadow');

const closedCurrent = observation('closed-current', categories.map(category =>
  leaf(category, category === 'source' ? '2'.repeat(64) : '1'.repeat(64))));
const rejected = await runCiInputProofAdapter(request(closedCurrent), compareLeafInventories);
assert.equal(rejected.exitCode, 0);
assert.equal(rejected.report.execution.status, 'passed');
assert.equal(rejected.report.candidateOmitObservation.status, 'not-eligible');
assert.equal(rejected.report.candidateOmitObservation.reason, 'input-proof-rejected:closed-input-changed');
assert.equal(rejected.report.omission.status, 'not-attempted');

const incompleteScope = Object.freeze({
  ...observation('current').scope,
  source: Object.freeze([]),
});
const incomplete = await runCiInputProofAdapter(
  request(observation('incomplete-current', undefined, incompleteScope)),
  compareLeafInventories,
);
assert.equal(incomplete.exitCode, 0);
assert.equal(incomplete.report.execution.status, 'passed');
assert.match(incomplete.report.candidateOmitObservation.reason, /^incomplete-observation:/u);
assert.equal(incomplete.report.omission.status, 'not-attempted');

const beforeScope = observation('before').scope;
const swappedScope = Object.freeze({
  ...beforeScope,
  source: beforeScope.helpers,
  helpers: beforeScope.source,
});
const scopeDrift = await runCiInputProofAdapter(
  request(observation('scope-current', undefined, swappedScope)),
  compareLeafInventories,
);
assert.equal(scopeDrift.exitCode, 0);
assert.equal(scopeDrift.report.execution.status, 'passed');
assert.match(scopeDrift.report.candidateOmitObservation.reason, /observation:scope-drift/u);

const failedFull = await runCiInputProofAdapter(
  request(observation('failed-current'), ['-e', 'process.stdout.write("FULL-PASS"); process.exit(23)']),
  compareLeafInventories,
);
assert.equal(failedFull.exitCode, 23);
assert.equal(failedFull.report.execution.status, 'failed');
assert.equal(failedFull.report.execution.full.exitCode, 23);
assert.equal(failedFull.report.optimizer.status, 'unavailable');
assert.equal(failedFull.report.omission.status, 'not-attempted');

const signalled = await runCiInputProofAdapter(
  request(
    observation('signal-current'),
    ['-e', 'process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 1000);'],
  ),
  compareLeafInventories,
);
assert.notEqual(signalled.exitCode, 0);
assert.equal(signalled.report.execution.status, 'failed');
if (process.platform === 'win32') {
  assert.ok(['process-failed', 'process-signal'].includes(signalled.report.execution.full.reason ?? ''));
} else {
  assert.equal(signalled.report.execution.full.reason, 'process-signal');
}

const timeoutReadyPath = resolve(process.cwd(), 'timeout-handler-ready-TEST');
const timedOut = await runCiInputProofAdapter(
  request(
    observation('timeout-current'),
    ['-e', 'const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => setTimeout(() => process.exit(0), 5)); writeFileSync(process.argv[1], "ready"); setTimeout(() => {}, 5000);', timeoutReadyPath],
    1000,
  ),
  compareLeafInventories,
);
assert.equal(await waitForFixtureFile(timeoutReadyPath), 'ready');
assert.notEqual(timedOut.exitCode, 0);
assert.equal(timedOut.report.execution.status, 'failed');
assert.equal(timedOut.report.execution.full.reason, 'process-timeout');
assert.ok(timedOut.report.timingsMs.full >= 975);
assert.ok(timedOut.report.timingsMs.full < 6000);
if (process.platform !== 'win32') {
  assert.equal(timedOut.report.execution.full.exitCode, 0);
}

const descendantPidPath = resolve(process.cwd(), 'descendant-pid.json');
const descendantReadyPath = resolve(process.cwd(), 'descendant-ready.json');
let descendantPid: number | null = null;
try {
const descendantScript = [
  'const { spawn } = require("node:child_process");',
  'const { writeFileSync } = require("node:fs");',
  'const child = spawn(process.execPath, [\\'-e\\', \\'const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); writeFileSync(process.argv[1], "ready"); setInterval(() => {}, 1000);\\', process.argv[2]], { stdio: ["ignore", 1, 2] });',
  'writeFileSync(process.argv[1], String(child.pid));',
  'setInterval(() => {}, 1000);',
].join('');
const descendantTimeout = await runCiInputProofAdapter(
  request(
    observation('descendant-timeout-current'),
    ['-e', descendantScript, descendantPidPath, descendantReadyPath],
    1000,
  ),
  compareLeafInventories,
);
assert.equal(await waitForFixtureFile(descendantReadyPath), 'ready');
assert.notEqual(descendantTimeout.exitCode, 0);
assert.equal(descendantTimeout.report.execution.status, 'failed');
assert.equal(descendantTimeout.report.execution.full.reason, 'process-timeout');
descendantPid = Number(await waitForFixtureFile(descendantPidPath));
assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
let descendantPresent = true;
try {
  process.kill(descendantPid, 0);
} catch (error) {
  assert.ok(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH');
  descendantPresent = false;
}
if (descendantPresent) {
  if (process.platform !== 'linux') {
    assert.fail('Inherited descendant remained live after timeout cleanup.');
  }
  try {
    const processStat = readFileSync('/proc/' + String(descendantPid) + '/stat', 'utf8');
    const stateStart = processStat.lastIndexOf(') ');
    assert.ok(stateStart >= 0);
    assert.equal(processStat.slice(stateStart + 2).trim().split(/\\s+/u)[0], 'Z');
    const descriptors = readdirSync('/proc/' + String(descendantPid) + '/fd');
    for (const descriptor of descriptors) {
      assert.doesNotMatch(
        readlinkSync('/proc/' + String(descendantPid) + '/fd/' + descriptor),
        /^pipe:\\[/u,
      );
    }
  } catch (error) {
    assert.ok(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
  }
}
} finally {
  if (descendantPid !== null) {
    killRecordedPid(descendantPid);
  }
}

const escalationReadyPath = resolve(process.cwd(), 'escalation-handler-ready-TEST');
const escalationRequest = request(
  observation('escalation-current'),
  ['-e', 'const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); writeFileSync(process.argv[1], "ready"); setTimeout(() => {}, 5000);', escalationReadyPath],
  1000,
);
const escalated = await runCiInputProofAdapter(escalationRequest, compareLeafInventories);
assert.equal(await waitForFixtureFile(escalationReadyPath), 'ready');
assert.notEqual(escalated.exitCode, 0);
assert.equal(escalated.report.execution.status, 'failed');
assert.equal(escalated.report.execution.full.reason, 'process-timeout');
assert.ok(escalated.report.timingsMs.full >= 975);
assert.ok(escalated.report.timingsMs.full < 6000);
if (process.platform !== 'win32') {
  assert.equal(escalated.report.execution.full.signal, 'SIGKILL');
}

const boundedOutput = await executeFixedFull({
  command: process.execPath,
  args: ['-e', 'process.stdout.write("x".repeat(65537))'],
  cwd: resolve(process.cwd()),
  timeoutMs: 5000,
});
assert.equal(boundedOutput.report.status, 'passed');
assert.equal(boundedOutput.report.exitCode, 0);
assert.equal(boundedOutput.report.outputTruncated, true);
assert.equal(boundedOutput.stdout.length, 64 * 1024);

const inheritedPipeRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ci-input-proof-inherited-pipe-TEST-'));
let escapedPid: number | null = null;
try {
  const escapedPidPath = join(inheritedPipeRoot, 'escaped-pid');
  const escapedReadyPath = join(inheritedPipeRoot, 'escaped-ready');
  const escapedScript = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const child = spawn(process.execPath, [\\'-e\\', \\'const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); writeFileSync(process.argv[1], "ready"); setInterval(() => {}, 1000);\\', process.argv[2]], { detached: true, stdio: ["ignore", 1, 2] });',
    'child.unref();',
    'writeFileSync(process.argv[1], String(child.pid));',
    'process.stdout.write("x".repeat(65537));',
    'process.stderr.write("x".repeat(65537));',
  ].join('');
  const inheritedStarted = Date.now();
  const inheritedPipe = await executeFixedFull({
    command: process.execPath,
    args: ['-e', escapedScript, escapedPidPath, escapedReadyPath],
    cwd: inheritedPipeRoot,
    timeoutMs: 5000,
  });
  const inheritedElapsedMs = Date.now() - inheritedStarted;
  escapedPid = Number(await waitForFixtureFile(escapedPidPath));
  assert.equal(await waitForFixtureFile(escapedReadyPath), 'ready');
  assert.ok(Number.isSafeInteger(escapedPid) && escapedPid > 0);
  assert.equal(inheritedPipe.report.exitCode, 0);
  assert.equal(inheritedPipe.report.outputTruncated, true);
  assert.equal(inheritedPipe.stdout.length, 64 * 1024);
  assert.ok(inheritedElapsedMs < 3000);
  if (process.platform === 'win32') {
    assert.equal(inheritedPipe.report.status, 'passed');
    assert.equal(inheritedPipe.report.reason, null);
  } else {
    assert.equal(inheritedPipe.report.status, 'failed');
    assert.equal(inheritedPipe.report.errorCode, 'process-stream-settlement-timeout');
    assert.equal(inheritedPipe.report.reason, 'process-settlement-failed');
    process.kill(escapedPid, 0);
  }
} finally {
  if (escapedPid !== null) {
    killRecordedPid(escapedPid);
  }
  await rm(inheritedPipeRoot, { recursive: true, force: true });
}

process.stdout.write(JSON.stringify({
  status: 'passed',
  cases: [
    'positive-full-pass',
    'closed-drift-full-pass',
    'incomplete-full-pass',
    'scope-drift-full-pass',
    'optimizer-unavailable-full-failed-nonzero',
    'signal-full-failed-nonzero',
    'timeout-full-failed-nonzero',
    'timeout-descendant-tree-cleaned',
    'timeout-escalation-full-failed-nonzero',
    'output-bound-full-pass',
    'inherited-pipe-bounded-settlement',
  ],
  timingsMs: {
    positive: positive.report.timingsMs,
    rejected: rejected.report.timingsMs,
    incomplete: incomplete.report.timingsMs,
    scopeDrift: scopeDrift.report.timingsMs,
    failedFull: failedFull.report.timingsMs,
    signalled: signalled.report.timingsMs,
    timedOut: timedOut.report.timingsMs,
    descendantTimeout: descendantTimeout.report.timingsMs,
    escalated: escalated.report.timingsMs,
  },
}) + '\\n');
`;

const windowsManagedProcessRuntimeFiles = Object.freeze([
  'binary-string-comparator.js',
  'features/validation-reporting/api.js',
  'features/validation-reporting/application/cancellation.js',
  'features/validation-reporting/application/capability-registries.js',
  'features/validation-reporting/application/model.js',
  'features/validation-reporting/application/reporting.js',
  'features/validation-reporting/application/unexpected-failure.js',
  'features/validation-reporting/application/unique-registry.js',
  'features/validation-reporting/foundation-error.js',
  'process-execution/application/errors.js',
  'process-execution/application/process-failure-policy.js',
  'process-execution/windows-managed-process-diagnostics.js',
  'process-execution/windows-managed-process.js',
  'process-execution/windows-process-host.js',
]);

export async function writePackedCiInputProofHarness(
  consumerRoot: string,
  repositoryRoot: string,
): Promise<void> {
  await mkdir(join(consumerRoot, 'scripts'), { recursive: true });
  await copyFile(
    resolve(repositoryRoot, 'scripts/ci-input-proof-foundation-adapter.mts'),
    join(consumerRoot, 'scripts', 'ci-input-proof-foundation-adapter.mts'),
  );
  await copyFile(
    resolve(repositoryRoot, 'scripts/ci-input-proof-full.mts'),
    join(consumerRoot, 'scripts', 'ci-input-proof-full.mts'),
  );
  for (const relativePath of windowsManagedProcessRuntimeFiles) {
    const destination = join(consumerRoot, 'packages', 'engineering-foundation', 'dist', relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(
      resolve(repositoryRoot, 'packages', 'engineering-foundation', 'dist', relativePath),
      destination,
    );
  }
  for (const assetName of ['bootstrap.ps1', 'WindowsManagedProcess.cs']) {
    const destination = join(
      consumerRoot,
      'packages',
      'engineering-foundation',
      'assets',
      'windows-managed-process',
      assetName,
    );
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(
      resolve(repositoryRoot, 'packages', 'engineering-foundation', 'assets', 'windows-managed-process', assetName),
      destination,
    );
  }
  await copyFile(
    resolve(repositoryRoot, 'tests/fixtures/ci-input-proof/foundation-pilot.TEST.mts'),
    join(consumerRoot, 'typed-public-api.TEST.mts'),
  );
  await writeFile(join(consumerRoot, 'deep-import-rejected.TEST.mts'), packedDeepImportSource, 'utf8');
  await writeFile(join(consumerRoot, 'adapter-conformance.TEST.mts'), packedRunnerSource, 'utf8');
  await writeJson(join(consumerRoot, 'tsconfig.json'), {
    compilerOptions: {
      exactOptionalPropertyTypes: true,
      allowImportingTsExtensions: true,
      forceConsistentCasingInFileNames: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: false,
      strict: true,
      target: 'ES2024',
      types: ['node'],
      verbatimModuleSyntax: true,
    },
    include: [
      'scripts/ci-input-proof-foundation-adapter.mts',
      'scripts/ci-input-proof-full.mts',
      'typed-public-api.TEST.mts',
      'deep-import-rejected.TEST.mts',
      'adapter-conformance.TEST.mts',
    ],
  });
}
