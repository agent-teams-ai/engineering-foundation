import assert from 'node:assert/strict';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCiInputProofAdapter } from '../../../scripts/ci-input-proof-foundation-adapter.mts';
import { executeFixedFull } from '../../../scripts/ci-input-proof-full.mts';
import { compareLeafInventories } from '../../../packages/ci-input-proof/dist/index.js';
import { adapterObservation, adapterRequest } from '../../support/ci-input-proof-adapter-fixtures.mts';

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
    await new Promise(_resolve => {
      setTimeout(_resolve, 10);
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

void test('signal termination and timeout exit zero never produce adapter PASS', async context => {
  const readinessRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ci-input-proof-timeout-readiness-TEST-'));
  context.after(async () => rm(readinessRoot, { recursive: true, force: true }));
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

  const timeoutReadyPath = resolve(readinessRoot, 'timeout-handler-ready-TEST');
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

  const escalationReadyPath = resolve(readinessRoot, 'escalation-handler-ready-TEST');
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

