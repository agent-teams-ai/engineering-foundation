import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

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

const maxProcessOutput = 64 * 1024;
const cleanupGraceMs = 1_000;

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
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

async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const taskkill = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      taskkill.once('error', () => {
        resolve();
      });
      taskkill.once('close', () => {
        resolve();
      });
    });
    return;
  }
  signalPosixProcessGroup(pid, 'SIGTERM');
  if (await waitForPosixProcessGroup(pid, cleanupGraceMs)) {
    return;
  }
  signalPosixProcessGroup(pid, 'SIGKILL');
  if (!await waitForPosixProcessGroup(pid, cleanupGraceMs)) {
    throw new Error(`process group ${String(pid)} did not exit after forced shutdown`);
  }
}

export async function executeFixedFull(spec: CheckCommand): Promise<ExecutedFull> {
  return await new Promise(resolve => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: resolvePath(spec.cwd),
      env: Object.freeze({
        PATH: process.env.PATH ?? '',
        TMPDIR: process.env.TMPDIR ?? '',
        NODE_ENV: process.env.NODE_ENV ?? '',
        CI: process.env.CI ?? '',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    let errorCode: string | null = null;
    let cleanupStarted = false;
    let cleanup: Promise<void> = Promise.resolve();
    const startCleanup = (): void => {
      if (cleanupStarted || child.pid === undefined) {
        return;
      }
      cleanupStarted = true;
      cleanup = terminateProcessTree(child.pid).catch((error: unknown) => {
        errorCode = error instanceof Error ? error.message : 'process-cleanup-failed';
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      startCleanup();
    }, spec.timeoutMs);
    const collect = (current: string, chunk: Buffer): Readonly<{ text: string; truncated: boolean }> => {
      const room = maxProcessOutput - current.length;
      const text = current + chunk.subarray(0, Math.max(0, room)).toString('utf8');
      return { text, truncated: chunk.length > Math.max(0, room) };
    };
    child.stdout.on('data', (chunk: Buffer) => {
      const result = collect(stdout, chunk);
      stdout = result.text;
      outputTruncated ||= result.truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const result = collect(stderr, chunk);
      stderr = result.text;
      outputTruncated ||= result.truncated;
    });
    child.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      errorCode = typeof code === 'string' ? code : 'process-error';
    });
    child.once('exit', startCleanup);
    child.on('close', (exitCode, signal) => {
      if (settled) {
        return;
      }
      startCleanup();
      void cleanup.then(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const status = errorCode !== null && !timedOut
          ? 'unavailable' as const
          : !timedOut && exitCode === 0 && signal === null ? 'passed' as const : 'failed' as const;
        resolve({
          report: Object.freeze({
            status,
            exitCode,
            signal,
            errorCode,
            outputTruncated,
            reason: timedOut ? 'process-timeout'
              : errorCode !== null ? 'process-unavailable'
              : signal !== null ? 'process-signal'
              : exitCode === 0 ? null : 'process-failed',
          }),
          stdout,
        });
        return null;
      });
    });
  });
}
