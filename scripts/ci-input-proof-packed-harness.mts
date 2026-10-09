import { copyFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
} from './adapter.mts';
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
  request(observation('failed-current'), ['-e', 'process.exit(23)']),
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

const timedOut = await runCiInputProofAdapter(
  request(
    observation('timeout-current'),
    ['-e', 'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 5)); setTimeout(() => {}, 1000);'],
    50,
  ),
  compareLeafInventories,
);
assert.notEqual(timedOut.exitCode, 0);
assert.equal(timedOut.report.execution.status, 'failed');
assert.equal(timedOut.report.execution.full.reason, 'process-timeout');
if (process.platform !== 'win32') {
  assert.equal(timedOut.report.execution.full.exitCode, 0);
}

const descendantPidPath = resolve(process.cwd(), 'descendant-pid.json');
const descendantScript = [
  'const { spawn } = require("node:child_process");',
  'const { writeFileSync } = require("node:fs");',
  'const child = spawn(process.execPath, [\\'-e\\', \\'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\\'], { stdio: ["ignore", 1, 2] });',
  'writeFileSync(process.argv[1], String(child.pid));',
  'setInterval(() => {}, 1000);',
].join('');
const descendantTimeout = await runCiInputProofAdapter(
  request(
    observation('descendant-timeout-current'),
    ['-e', descendantScript, descendantPidPath],
    100,
  ),
  compareLeafInventories,
);
assert.notEqual(descendantTimeout.exitCode, 0);
assert.equal(descendantTimeout.report.execution.status, 'failed');
assert.equal(descendantTimeout.report.execution.full.reason, 'process-timeout');
const descendantPid = Number(await readFile(descendantPidPath, 'utf8'));
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

const escalationRequest = request(
  observation('escalation-current'),
  ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 2000);'],
  50,
);
const escalated = await runCiInputProofAdapter(escalationRequest, compareLeafInventories);
assert.notEqual(escalated.exitCode, 0);
assert.equal(escalated.report.execution.status, 'failed');
assert.equal(escalated.report.execution.full.reason, 'process-timeout');

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

export async function writePackedCiInputProofHarness(
  consumerRoot: string,
  repositoryRoot: string,
): Promise<void> {
  await copyFile(
    resolve(repositoryRoot, 'scripts/ci-input-proof-foundation-adapter.mts'),
    join(consumerRoot, 'adapter.mts'),
  );
  await copyFile(
    resolve(repositoryRoot, 'scripts/ci-input-proof-full.mts'),
    join(consumerRoot, 'ci-input-proof-full.mts'),
  );
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
      'adapter.mts',
      'ci-input-proof-full.mts',
      'typed-public-api.TEST.mts',
      'deep-import-rejected.TEST.mts',
      'adapter-conformance.TEST.mts',
    ],
  });
}
