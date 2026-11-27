import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { observationChildEnvironment } from "../ef70-managed-campaign/owned-root.ts";
import { type Row } from "../ef70-managed-campaign/campaign-io.ts";
import { AdoptionEvidence, errorObservation } from "./evidence.ts";
import { retainAt, sha256 } from "./files.ts";
import { processIdentity, type ProcessIdentity } from "./processes.ts";

const maximum = 32 * 1024 * 1024;
interface SinkResult {
  readonly bytes: Buffer;
  readonly overflow: boolean;
  readonly errors: readonly Row[];
}
interface Sink {
  readonly write: (chunk: Buffer) => void;
  readonly finish: () => SinkResult;
}
function sink(path: string): Sink {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const chunks: Buffer[] = [],
    errors: Row[] = [];
  let length = 0,
    overflow = false,
    closed = false;
  return {
    write(chunk) {
      if (closed) {
        return;
      }
      const retained = chunk.subarray(0, Math.max(0, maximum - length));
      overflow ||= retained.length !== chunk.length;
      try {
        let offset = 0;
        while (offset < retained.length) {
          const written = writeSync(fd, retained, offset, retained.length - offset);
          assert(written > 0, "Short command evidence write");
          chunks.push(Buffer.from(retained.subarray(offset, offset + written)));
          offset += written;
          length += written;
        }
      } catch (error) {
        errors.push(errorObservation(error));
        closed = true;
        try {
          closeSync(fd);
        } catch (closeError) {
          errors.push(errorObservation(closeError));
        }
      }
    },
    finish() {
      if (!closed) {
        closed = true;
        try {
          closeSync(fd);
        } catch (error) {
          errors.push(errorObservation(error));
        }
      }
      return { bytes: Buffer.concat(chunks), overflow, errors };
    },
  };
}
export interface TerminalObservation {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error: Row | null;
  readonly timedOut: boolean;
  readonly streamsClosed: boolean;
  readonly identity: ProcessIdentity | null;
  readonly stdoutOverflow: boolean;
  readonly stderrOverflow: boolean;
  readonly captureErrors: readonly Row[];
}
export function assertTerminalSuccess(observed: TerminalObservation): void {
  assert.equal(observed.status, 0, "Actual public command failed");
  assert.equal(observed.signal, null, "Public command ended by signal");
  assert.equal(observed.error, null, "Public command/identity/stream observation failed");
  assert.equal(observed.timedOut, false, "Deadline failure is not a completed operation");
  assert.equal(observed.streamsClosed, true, "Unclosed streams retain process uncertainty");
  assert(
    observed.identity !== null &&
      Number.isSafeInteger(observed.identity.pid) &&
      observed.identity.pid > 0 &&
      /^[0-9]+$/u.test(observed.identity.start),
    "Actual PID/start observation required",
  );
  assert.equal(observed.stdoutOverflow, false);
  assert.equal(observed.stderrOverflow, false);
  assert.deepEqual(observed.captureErrors, []);
}
interface ExitObservation {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error: Row | null;
  readonly timedOut: boolean;
  readonly streamsClosed: boolean;
  readonly identity: ProcessIdentity | null;
  readonly timeoutSignalRequested: boolean;
}
function commandErrors() {
  const errors: Row[] = [];
  let omittedCount = 0;
  return {
    add(source: string, error: unknown): void {
      if (errors.length < 32) {
        errors.push({ source, error: errorObservation(error) });
      } else {
        omittedCount += 1;
      }
    },
    observation(): Row | null {
      return errors.length === 0
        ? null
        : { name: "CommandObservationErrors", errors: [...errors], omittedCount };
    },
  };
}
type PublicChild = ChildProcessByStdio<null, Readable, Readable>;
function watchChild(child: PublicChild, stdout: Sink, stderr: Sink): Promise<ExitObservation> {
  return new Promise((resolve) => {
    const errors = commandErrors();
    let identity: ProcessIdentity | null = null;
    let done = false,
      timedOut = false,
      timeoutSignalRequested = false;
    let grace: ReturnType<typeof setTimeout> | undefined,
      deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      status: number | null,
      signal: NodeJS.Signals | null,
      streamsClosed: boolean,
    ): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(deadline);
      if (grace !== undefined) {
        clearTimeout(grace);
      }
      resolve({
        status,
        signal,
        error: errors.observation(),
        timedOut,
        streamsClosed,
        identity,
        timeoutSignalRequested,
      });
    };
    child.on("spawn", () => {
      try {
        assert(child.pid !== undefined);
        identity = processIdentity(child.pid) ?? null;
        assert(identity !== null, "Spawned child identity could not be observed");
      } catch (failure) {
        errors.add("spawn-identity", failure);
      }
    });
    child.stdout.on("data", (chunk: Buffer) => stdout.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.write(chunk));
    child.stdout.on("error", (failure) => errors.add("stdout", failure));
    child.stderr.on("error", (failure) => errors.add("stderr", failure));
    child.on("error", (failure) => errors.add("child", failure));
    child.on("close", (code, signal) => finish(code, signal, true));
    deadline = setTimeout(() => {
      timedOut = true;
      try {
        if (identity !== null && processIdentity(identity.pid)?.start === identity.start) {
          timeoutSignalRequested = child.kill("SIGTERM");
        }
      } catch (failure) {
        errors.add("deadline-signal", failure);
      }
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(child.exitCode, child.signalCode, false);
      }, 5_000);
    }, 960_000);
  });
}
export interface PublicCommandResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly terminal: TerminalObservation;
  readonly evidencePath: string;
}
interface PublicRequest {
  readonly label: "prepare" | "finalize" | "check-target" | "restore-current";
  readonly executable: string;
  readonly cli: string;
  readonly args: readonly string[];
}
async function launch(evidence: AdoptionEvidence, request: PublicRequest) {
  const stem = join(evidence.operationRoot, request.label);
  let stdout: Sink | undefined, stderr: Sink | undefined;
  let child: PublicChild | undefined;
  let observed: ExitObservation;
  try {
    stdout = sink(stem + ".stdout");
    stderr = sink(stem + ".stderr");
    child = spawn(request.executable, [request.cli, ...request.args], {
      cwd: evidence.config.consumer,
      shell: false,
      env: observationChildEnvironment(evidence.config.environment),
      stdio: ["ignore", "pipe", "pipe"],
    });
    observed = await watchChild(child, stdout, stderr);
  } catch (error) {
    observed = {
      status: null,
      signal: null,
      error: errorObservation(error),
      timedOut: false,
      streamsClosed: child === undefined,
      identity: null,
      timeoutSignalRequested: false,
    };
  }
  const empty: SinkResult = { bytes: Buffer.alloc(0), overflow: false, errors: [] };
  const out = stdout?.finish() ?? empty,
    err = stderr?.finish() ?? empty;
  return { out, err, observed };
}
export async function publicCommand(
  evidence: AdoptionEvidence,
  request: PublicRequest,
): Promise<PublicCommandResult> {
  const startedAt = new Date().toISOString();
  const { out, err, observed } = await launch(evidence, request);
  const terminal = {
    ...observed,
    stdoutOverflow: out.overflow,
    stderrOverflow: err.overflow,
    captureErrors: [...out.errors, ...err.errors],
  };
  const evidencePath = retainAt(
    evidence.config.roots.evidenceRoot,
    "case-canonical/" + request.label + ".json",
    JSON.stringify(
      {
        label: request.label,
        executable: request.executable,
        arguments: [request.cli, ...request.args],
        cwd: evidence.config.consumer,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...terminal,
        stdoutSha256: sha256(out.bytes),
        stderrSha256: sha256(err.bytes),
        stdoutBytes: out.bytes.length,
        stderrBytes: err.bytes.length,
        scope:
          "One actual invocation; no retry, rollback, lease deletion or complete process-tree termination claim.",
      },
      null,
      2,
    ) + "\n",
  );
  return { stdout: out.bytes, stderr: err.bytes, terminal, evidencePath };
}
