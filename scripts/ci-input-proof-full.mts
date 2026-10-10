import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { Readable } from 'node:stream';

export type CheckCommand = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}>;
export type ProcessReport = Readonly<{
  status: 'passed' | 'failed' | 'unavailable';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  errorCode: string | null;
  outputTruncated: boolean;
  reason: string | null;
}>;
export type ExecutedFull = Readonly<{ report: ProcessReport; stdout: string }>;

type WindowsManagedProcessRequest = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  launcherEnvironment: Readonly<NodeJS.ProcessEnv>;
}>;
type WindowsManagedProcessModule = Readonly<{
  cleanUpWindowsManagedProcessLaunchFailure: (child: ChildProcess) => void;
  requestWindowsManagedProcessTermination: (child: ChildProcess) => Promise<void>;
  spawnWindowsManagedProcess: (request: WindowsManagedProcessRequest) => ChildProcess;
}>;
type ProcessOutcome = Readonly<
  | { kind: 'exit'; exitCode: number | null; signal: NodeJS.Signals | null }
  | { kind: 'error'; errorCode: string }
>;
type BoundedSettlement = Readonly<{ error: string | null; settled: boolean }>;
type OutputStream = {
  chunks: Buffer[];
  failure: string | null;
  settled: boolean;
  truncated: boolean;
  bytes: number;
};

const maxProcessOutputBytes = 64 * 1024;
const cleanupGraceMs = 1_000;
const cleanupSettlementMs = 5_000;
const exitSettlementMs = 1_000;
const streamSettlementMs = 500;
const windowsManagedProcessModuleUrl = new URL(
  '../packages/engineering-foundation/dist/process-execution/windows-managed-process.js',
  import.meta.url,
);

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return fallback;
}

function signalPosixProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!isMissingProcess(error)) {
      throw error;
    }
  }
}

function processGroupPresent(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return !isMissingProcess(error);
  }
}

type PosixProcessObservation = Readonly<{
  state: string;
  processGroupId: number;
}>;

function readPosixProcessObservation(pid: number): PosixProcessObservation | null {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const stateStart = stat.lastIndexOf(') ');
    if (stateStart < 0) {
      throw new Error(`Process ${String(pid)} has an invalid /proc stat record.`);
    }
    const fields = stat.slice(stateStart + 2).trim().split(/\s+/u);
    const state = fields[0] ?? '';
    const processGroupId = Number(fields[2]);
    if (processGroupId === 0) {
      return null;
    }
    if (state.length === 0 || !Number.isFinite(processGroupId) || processGroupId < 0) {
      throw new Error(`Process ${String(pid)} has an invalid /proc stat record.`);
    }
    return Object.freeze({ state, processGroupId });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function posixProcessGroupHasLiveMembers(processGroupId: number): boolean {
  if (process.platform !== 'linux') {
    return processGroupPresent(processGroupId);
  }
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    const observation = readPosixProcessObservation(Number(entry));
    if (observation !== null && observation.processGroupId === processGroupId && observation.state !== 'Z') {
      return true;
    }
  }
  return false;
}

async function waitForPosixProcessGroup(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (posixProcessGroupHasLiveMembers(processGroupId) && Date.now() < deadline) {
    await new Promise(resolve => {
      setTimeout(resolve, 25);
    });
  }
  return !posixProcessGroupHasLiveMembers(processGroupId);
}

async function terminatePosixProcessGroup(processGroupId: number): Promise<void> {
  signalPosixProcessGroup(processGroupId, 'SIGTERM');
  if (await waitForPosixProcessGroup(processGroupId, cleanupGraceMs)) {
    return;
  }
  signalPosixProcessGroup(processGroupId, 'SIGKILL');
  if (!await waitForPosixProcessGroup(processGroupId, cleanupGraceMs)) {
    throw new Error(`process group ${String(processGroupId)} did not exit after forced shutdown`);
  }
}

async function loadWindowsManagedProcess(): Promise<WindowsManagedProcessModule> {
  return await import(windowsManagedProcessModuleUrl.href) as WindowsManagedProcessModule;
}

function fullEnvironment(): Readonly<NodeJS.ProcessEnv> {
  return Object.freeze({
    PATH: process.env.PATH ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
    NODE_ENV: process.env.NODE_ENV ?? '',
    CI: process.env.CI ?? '',
  });
}

function spawnCommand(
  spec: CheckCommand,
  windowsManagedProcess: WindowsManagedProcessModule | null,
): ChildProcess {
  const cwd = resolvePath(spec.cwd);
  const environment = fullEnvironment();
  if (windowsManagedProcess !== null) {
    return windowsManagedProcess.spawnWindowsManagedProcess({
      command: spec.command,
      args: [...spec.args],
      cwd,
      environment,
      launcherEnvironment: process.env,
    });
  }
  return spawn(spec.command, [...spec.args], {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    windowsHide: true,
  });
}

function createOutputStream(): OutputStream {
  return {
    chunks: [],
    failure: null,
    settled: false,
    truncated: false,
    bytes: 0,
  };
}

function appendOutput(output: OutputStream, chunk: Buffer): void {
  const room = maxProcessOutputBytes - output.bytes;
  const accepted = chunk.subarray(0, Math.max(0, room));
  if (accepted.length > 0) {
    output.chunks.push(Buffer.from(accepted));
    output.bytes += accepted.length;
  }
  output.truncated ||= chunk.length > accepted.length;
}

function outputText(output: OutputStream): string {
  return Buffer.concat(output.chunks).toString('utf8');
}

function monitorOutput(stream: Readable, output: OutputStream): void {
  stream.on('data', (chunk: Buffer) => {
    appendOutput(output, chunk);
  });
  stream.once('end', () => {
    output.settled = true;
  });
  stream.once('close', () => {
    output.settled = true;
  });
  stream.once('error', (error: Error) => {
    output.failure = errorCode(error, 'process-stream-error');
    output.settled = true;
  });
}

async function settleWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
  fallbackCode: string,
): Promise<BoundedSettlement> {
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  const bounded = Promise.race([
    operation.then(
      () => null,
      (error: unknown) => errorCode(error, fallbackCode),
    ),
    new Promise<string>(resolve => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve(fallbackCode);
      }, timeoutMs);
    }),
  ]);
  const error = await bounded;
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  void operation.catch(() => undefined);
  return Object.freeze({
    error: timedOut ? fallbackCode : error,
    settled: !timedOut && error === null,
  });
}

async function waitForOutputSettlement(
  stdout: OutputStream,
  stderr: OutputStream,
): Promise<BoundedSettlement> {
  const deadline = Date.now() + streamSettlementMs;
  while ((!stdout.settled || !stderr.settled) && Date.now() < deadline) {
    await new Promise(resolve => {
      setTimeout(resolve, 10);
    });
  }
  if (stdout.failure !== null || stderr.failure !== null) {
    return Object.freeze({
      error: stdout.failure ?? stderr.failure ?? 'process-stream-error',
      settled: false,
    });
  }
  return Object.freeze({
    error: stdout.settled && stderr.settled ? null : 'process-stream-settlement-timeout',
    settled: stdout.settled && stderr.settled,
  });
}

async function terminateProcessTree(
  child: ChildProcess,
  windowsManagedProcess: WindowsManagedProcessModule | null,
): Promise<void> {
  if (windowsManagedProcess !== null) {
    await windowsManagedProcess.requestWindowsManagedProcessTermination(child);
    return;
  }
  if (child.pid !== undefined) {
    await terminatePosixProcessGroup(child.pid);
  }
}

function processReason(
  timedOut: boolean,
  outcome: ProcessOutcome | null,
  settlementFailure: boolean,
): string | null {
  if (timedOut) {
    return 'process-timeout';
  }
  if (outcome === null) {
    return 'process-unavailable';
  }
  if (outcome.kind === 'error') {
    return 'process-unavailable';
  }
  if (outcome.signal !== null) {
    return 'process-signal';
  }
  if (outcome.exitCode !== 0) {
    return 'process-failed';
  }
  return settlementFailure ? 'process-settlement-failed' : null;
}

export async function executeFixedFull(spec: CheckCommand): Promise<ExecutedFull> {
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs <= 0) {
    throw new TypeError('The FULL process timeout must be a positive safe integer.');
  }
  let windowsManagedProcess: WindowsManagedProcessModule | null = null;
  try {
    windowsManagedProcess = process.platform === 'win32' ? await loadWindowsManagedProcess() : null;
  } catch (error) {
    return Object.freeze({
      report: Object.freeze({
        status: 'unavailable',
        exitCode: null,
        signal: null,
        errorCode: errorCode(error, 'windows-managed-process-unavailable'),
        outputTruncated: false,
        reason: 'process-unavailable',
      }),
      stdout: '',
    });
  }

  let child: ChildProcess;
  try {
    child = spawnCommand(spec, windowsManagedProcess);
  } catch (error) {
    return Object.freeze({
      report: Object.freeze({
        status: 'unavailable',
        exitCode: null,
        signal: null,
        errorCode: errorCode(error, 'process-error'),
        outputTruncated: false,
        reason: 'process-unavailable',
      }),
      stdout: '',
    });
  }

  const stdout = createOutputStream();
  const stderr = createOutputStream();
  if (child.stdout !== null) {
    monitorOutput(child.stdout, stdout);
  } else {
    stdout.settled = true;
  }
  if (child.stderr !== null) {
    monitorOutput(child.stderr, stderr);
  } else {
    stderr.settled = true;
  }

  let resolveOutcome: (outcome: ProcessOutcome) => void = () => undefined;
  const outcomePromise = new Promise<ProcessOutcome>(resolve => {
    resolveOutcome = resolve;
  });
  child.once('exit', (exitCode, signal) => {
    resolveOutcome({ kind: 'exit', exitCode, signal });
  });
  child.once('error', (error: Error) => {
    if (windowsManagedProcess !== null) {
      windowsManagedProcess.cleanUpWindowsManagedProcessLaunchFailure(child);
    }
    resolveOutcome({ kind: 'error', errorCode: errorCode(error, 'process-error') });
  });

  let triggerCleanup: () => void = () => undefined;
  const cleanupTriggered = new Promise<void>(resolve => {
    triggerCleanup = resolve;
  });
  let cleanupStarted = false;
  let cleanup: Promise<void> = Promise.resolve();
  const startCleanup = (): void => {
    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;
    cleanup = terminateProcessTree(child, windowsManagedProcess);
    triggerCleanup();
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    startCleanup();
  }, spec.timeoutMs);
  void outcomePromise.then(startCleanup);

  await cleanupTriggered;
  const cleanupSettlement = await settleWithin(
    cleanup,
    cleanupSettlementMs,
    'process-cleanup-settlement-timeout',
  );
  const observedOutcome = await Promise.race([
    outcomePromise.then((outcome: ProcessOutcome): ProcessOutcome | null => outcome),
    new Promise<null>(resolve => {
      setTimeout(() => {
        resolve(null);
      }, exitSettlementMs);
    }),
  ]);
  const outputSettlement = await waitForOutputSettlement(stdout, stderr);
  if (!outputSettlement.settled) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  clearTimeout(timer);

  const outcome = observedOutcome;
  const settlementFailure = !cleanupSettlement.settled
    || !outputSettlement.settled
    || outcome === null;
  const processErrorCode = outcome?.kind === 'error'
    ? outcome.errorCode
    : cleanupSettlement.error
      ?? outputSettlement.error
      ?? (outcome === null ? 'process-exit-settlement-timeout' : null);
  const passed = !timedOut
    && outcome?.kind === 'exit'
    && outcome.exitCode === 0
    && outcome.signal === null
    && !settlementFailure;
  const status = passed
    ? 'passed' as const
    : timedOut || outcome?.kind === 'exit'
      ? 'failed' as const
      : 'unavailable' as const;
  return Object.freeze({
    report: Object.freeze({
      status,
      exitCode: outcome?.kind === 'exit' ? outcome.exitCode : null,
      signal: outcome?.kind === 'exit' ? outcome.signal : null,
      errorCode: processErrorCode,
      outputTruncated: stdout.truncated || stderr.truncated,
      reason: processReason(timedOut, outcome, settlementFailure),
    }),
    stdout: outputText(stdout),
  });
}
