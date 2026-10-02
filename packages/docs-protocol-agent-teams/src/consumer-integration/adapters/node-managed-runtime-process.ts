import { spawn, type ChildProcess } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { Writable } from "node:stream";
import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";
import { consumerTimeMilliseconds } from "./node-consumer-clock.js";
import { hashRuntimeFile, type RuntimeImage } from "./node-managed-runtime-identity.js";
import type { ProcessFacts, RuntimeRefusalCode, RuntimeTuple } from "../application/ports/managed-runtime.js";

const MAX_OUTPUT = 1024 * 1024;
const MAX_HANDSHAKE = 8 * 1024;
const PROBE_DEADLINE = 30_000;
const CLEANUP_WAIT = 1000;
const PROBE_SHA256 = "9f0c6946a07b9cd2e98727352768fb311e13ca4c08fa0f095d8f4b20c2eab671";
const scrubbedEnvironment = (cwd: string): NodeJS.ProcessEnv => ({
  CI: "true", LANG: "C", LC_ALL: "C", TZ: "UTC",
  TMPDIR: cwd, XDG_CACHE_HOME: cwd, XDG_CONFIG_HOME: cwd, XDG_DATA_HOME: cwd,
  NODE_COMPILE_CACHE: join(cwd, "node-compile-cache"),
  npm_config_userconfig: join(cwd, "user.npmrc"),
  npm_config_globalconfig: join(cwd, "global.npmrc"),
  npm_config_manage_package_manager_versions: "false",
  npm_config_engine_strict: "true", npm_config_strict_peer_dependencies: "true",
  COREPACK_ENABLE_NETWORK: "0"
});
export interface ProcessResult {
  readonly code: RuntimeRefusalCode | null;
  readonly facts: ProcessFacts;
  readonly handshake: RuntimeTuple | null;
  readonly output: string;
  readonly diagnosticTailBase64?: string;
}
function retainTail(previous: Buffer, chunk: Buffer): Buffer {
  if (chunk.length >= 4096) {return Buffer.from(chunk.subarray(-4096));}
  return Buffer.concat([previous, chunk]).subarray(-4096);
}
async function procStart(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const right = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return right[19] ?? "";
}
function groupState(pgid: number): "absent" | "present" | "unknown" {
  try { process.kill(-pgid, 0); return "present"; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {return "absent";}
    return "unknown";
  }
}
export interface ManagedProbeSignalSyscalls {
  groupState(pgid: number): "absent" | "present" | "unknown";
  signalGroup(pgid: number, signal: NodeJS.Signals): void;
}
const realSignals: ManagedProbeSignalSyscalls = {
  groupState,
  signalGroup: (pgid, signal) => { process.kill(-pgid, signal); }
};
async function waitGroup(pgid: number, milliseconds: number,
  syscalls: ManagedProbeSignalSyscalls): Promise<"absent" | "present" | "unknown"> {
  const until = consumerTimeMilliseconds() + milliseconds;
  let state = syscalls.groupState(pgid);
  while (state === "present" && consumerTimeMilliseconds() < until) {
    await delay(25);
    state = syscalls.groupState(pgid);
  }
  return state;
}
function waitChildClose(child: ChildProcess, alreadyClosed: () => boolean,
  milliseconds: number): Promise<boolean> {
  if (alreadyClosed()) {return Promise.resolve(true);}
  return new Promise((resolve) => {
    const onClose = (): void => {finish(true);};
    const timer = new AbortController();
    void delay(milliseconds, undefined, { signal: timer.signal }).then(() => {finish(false); return null;}, () => null);
    const finish = (closed: boolean): void => {
      timer.abort();
      child.removeListener("close", onClose);
      resolve(closed);
    };
    child.once("close", onClose);
  });
}
async function verifyHandshake(bytes: Buffer, image: RuntimeImage,
  expected: RuntimeTuple, pid: number, startIdentity: string | null): Promise<RuntimeTuple> {
  const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!line.endsWith("\n") || line.indexOf("\n") !== line.length - 1) {
    throw new Error("handshake framing");
  }
  const value: unknown = parseStrictJson(line.slice(0, -1));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {throw new Error("handshake shape");}
  const h = value as Record<string, unknown>;
  if (Object.keys(h).toSorted().join(",") !== "architecture,execPath,platform,version" ||
      h.execPath !== image.nodePath || h.version !== expected.nodeVersion ||
      h.platform !== "linux" || h.architecture !== "x64") {throw new Error("handshake mismatch");}
  const runningPath = await realpath(`/proc/${pid}/exe`);
  const running = await hashRuntimeFile(runningPath, 256 * 1024 * 1024, true);
  if (JSON.stringify(running) !== JSON.stringify(image.node) ||
      await procStart(pid) !== startIdentity) {
    throw new Error("running executable mismatch");
  }
  return { ...expected, nodeVersion: h.version };
}
async function terminateAttributedGroup(pid: number, startIdentity: string | null,
  syscalls: ManagedProbeSignalSyscalls): Promise<{
  state: "absent" | "present" | "unknown"; signalFailure: boolean }> {
  const attributable = async (): Promise<boolean> => {
    if (startIdentity === null || startIdentity === "") {return false;}
    try { return await procStart(pid) === startIdentity; } catch { return false; }
  };
  let state = syscalls.groupState(pid);
  let signalFailure = false;
  if (state === "present" && await attributable()) {
    try { syscalls.signalGroup(pid, "SIGTERM"); }
    catch (error) { signalFailure = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    state = await waitGroup(pid, CLEANUP_WAIT, syscalls);
    if (state === "present" && await attributable()) {
      try { syscalls.signalGroup(pid, "SIGKILL"); }
      catch (error) { signalFailure ||= (error as NodeJS.ErrnoException).code !== "ESRCH"; }
      state = await waitGroup(pid, CLEANUP_WAIT, syscalls);
    }
  }
  return { state, signalFailure };
}
/** Fixed probe only; no ambient command, argv or environment enters this boundary. */
interface ManagedProbeInput {
  readonly image: RuntimeImage;
  readonly expected: RuntimeTuple;
  readonly cwd: string;
  readonly kind: "node-identity" | "pnpm-version" | "pnpm-install-prepare" | "pnpm-install-frozen-offline" | "pnpm-peers-check";
  readonly signal: AbortSignal;
  readonly lifecycle?: {
    spawning(): Promise<void>;
    running(child: { readonly pid: number; readonly start: string; readonly pgid: number }): Promise<void>;
    stopping(): Promise<void>;
  };
}
class ManagedProbeOperation {
  private child: ChildProcess | null = null;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private handshakeBytes = 0;
  private cancelled: boolean;
  private timedOut = false;
  private failure: RuntimeRefusalCode | null;
  private streamError = false;
  private stdout: Buffer = Buffer.alloc(0);
  private handshake: Buffer = Buffer.alloc(0);
  private readonly stdoutDecoder = new TextDecoder("utf-8", { fatal: true });
  private readonly stderrDecoder = new TextDecoder("utf-8", { fatal: true });
  private diagnosticTail: Buffer = Buffer.alloc(0);
  private verifiedHandshake: Buffer | null = null;
  private stdoutClosed = false;
  private stderrClosed = false;
  private controlClosed = false;
  private childClosed = false;
  private observed: RuntimeTuple | null = null;
  private startIdentity: string | null = null;
  private probeReady = false;
  private readonly probePath = fileURLToPath(new URL("./managed-runtime-probe.js", import.meta.url));
  constructor(private readonly input: ManagedProbeInput, private readonly syscalls: ManagedProbeSignalSyscalls) {
    this.cancelled = input.signal.aborted;
    this.failure = this.cancelled ? "cancelled" : null;
  }
  private hasFailure(): boolean { return this.failure !== null; }
  private streamsAreClosed(): boolean { return this.stdoutClosed && this.stderrClosed && this.controlClosed; }
  private hasStreamError(): boolean { return this.streamError; }
  private validateChunk(decoder: TextDecoder, chunk: Buffer): void {
    if (this.stdoutBytes + this.stderrBytes > MAX_OUTPUT) {return;}
    try { decoder.decode(chunk, { stream: true }); }
    catch { this.failure ??= "invalid-output"; }
  }
  private facts(child: ChildProcess | null, group: ProcessFacts["group"], streams: ProcessFacts["streams"]): ProcessFacts {
  return { spawned: child !== null && child.pid !== undefined, exitCode: child?.exitCode ?? null,
    signal: child?.signalCode ?? null, cancelled: this.cancelled, timedOut: this.timedOut,
    stdoutBytes: this.stdoutBytes, stderrBytes: this.stderrBytes,
    directChild: child === null ? "not-started" :
      child.exitCode !== null || child.signalCode !== null ? "reaped" : "unconfirmed",
    group, streams };
}
  private wireStreams(owned: ChildProcess, control: Exclude<ChildProcess["stdio"][3], null | undefined | number>): void {
    control.on("data", (chunk: Buffer) => {
      this.handshakeBytes += chunk.length;
      if (this.handshakeBytes > MAX_HANDSHAKE) {this.failure ??= "invalid-output";}
      else {this.handshake = Buffer.concat([this.handshake, chunk]);}
    });
    control.on("error", () => { this.streamError = true; this.failure ??= "invalid-output"; });
    control.on("close", () => { this.controlClosed = true; });
    owned.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutBytes += chunk.length;
      this.diagnosticTail = retainTail(this.diagnosticTail, chunk);
      this.validateChunk(this.stdoutDecoder, chunk);
      if (this.stdoutBytes + this.stderrBytes > MAX_OUTPUT) {
        this.failure ??= "output-limit";
        this.stdout = Buffer.concat([this.stdout.subarray(-4096), chunk]).subarray(-4096);
      }
      else {this.stdout = Buffer.concat([this.stdout, chunk]);}
    });
    owned.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      this.diagnosticTail = retainTail(this.diagnosticTail, chunk);
      this.validateChunk(this.stderrDecoder, chunk);
      if (this.stdoutBytes + this.stderrBytes > MAX_OUTPUT) {this.failure ??= "output-limit";}
    });
    owned.stdout?.on("error", () => { this.streamError = true; this.failure ??= "invalid-output"; });
    owned.stderr?.on("error", () => { this.streamError = true; this.failure ??= "invalid-output"; });
    owned.stdout?.on("close", () => { this.stdoutClosed = true; });
    owned.stderr?.on("close", () => { this.stderrClosed = true; });
  }
  private async launch(): Promise<ProcessResult | { owned: ChildProcess; pid: number; releasePipe: Writable; probeBefore: Awaited<ReturnType<typeof hashRuntimeFile>> }> {
    const probeBefore = await hashRuntimeFile(this.probePath, 64 * 1024, false);
    if (probeBefore.sha256 !== PROBE_SHA256) {
      return { code: "identity-changed", facts: this.facts(null,
        "not-started", "not-started"), handshake: null, output: "" };
    }
    this.probeReady = true;
    if (this.hasFailure()) {
      return { code: this.failure, facts: this.facts(null,
        "not-started", "not-started"), handshake: null, output: "" };
    }
    await this.input.lifecycle?.spawning();
    this.child = spawn(this.input.image.nodePath,
      [this.probePath, this.input.kind, join(this.input.image.rootPath, "bin/pnpm.mjs")],
      { cwd: this.input.cwd, shell: false, detached: true, env: scrubbedEnvironment(this.input.cwd),
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
    const owned = this.child;
    owned.once("close", () => { this.childClosed = true; });
    owned.once("error", () => { this.failure ??= "spawn-failed"; });
    const pid = owned.pid;
    if (pid === undefined) { this.failure ??= "spawn-failed"; return { code: this.failure,
      facts: this.facts(null, "not-started", "not-started"),
      handshake: null, output: "" }; }
    const control = owned.stdio[3];
    const release = owned.stdio[4];
    if (!control || !release || typeof control === "number" || typeof release === "number") {throw new Error("missing-probe-pipes");}
    const releasePipe = release as Writable;
    this.wireStreams(owned, control);
    try { this.startIdentity = await procStart(pid); }
    catch { this.failure ??= "liveness-uncertain"; }
    if (!this.hasFailure() && this.startIdentity !== null && this.startIdentity !== "") {await this.input.lifecycle?.running({ pid, start: this.startIdentity, pgid: pid });}
    if (this.input.signal.aborted) { this.cancelled = true; this.failure ??= "cancelled"; }
    return { owned, pid, releasePipe, probeBefore };
  }
  private async releaseExecution(pid: number, releasePipe: Writable): Promise<void> {
    if (!this.hasFailure() && this.handshake.length > 0) {
      try {
        this.verifiedHandshake = Buffer.from(this.handshake);
        this.observed = await verifyHandshake(this.verifiedHandshake, this.input.image, this.input.expected, pid, this.startIdentity);
      }
      catch { this.failure ??= "runtime-mismatch"; }
    } else if (!this.hasFailure()) {this.failure = "deadline";}
    if (!this.hasFailure()) {releasePipe.end(Buffer.from("1"));}
    else {releasePipe.end();}
  }
  private async awaitExecution(owned: ChildProcess, pid: number, releasePipe: Writable, timeout: number): Promise<void> {
    // The child is blocked on fd 4 until both the private handshake and /proc witness agree.
    const until = consumerTimeMilliseconds() + timeout;
    while (!this.hasFailure() && !this.handshake.includes(10) && consumerTimeMilliseconds() < until) {
      if (owned.exitCode !== null || owned.signalCode !== null) { this.failure = "invalid-output"; break; }
      await delay(10);
    }
    await this.releaseExecution(pid, releasePipe);
    while (consumerTimeMilliseconds() < until) {
      if (this.hasFailure() || owned.exitCode !== null || owned.signalCode !== null) {break;}
      await delay(10);
    }
    if (!this.hasFailure() && owned.exitCode === null && owned.signalCode === null) {this.failure = "deadline";}
    if (!this.hasFailure() && owned.exitCode !== 0) {this.failure = "process-failed";}
  }
  private async readOutput(probeBefore: Awaited<ReturnType<typeof hashRuntimeFile>>): Promise<string> {
    let output = "";
    try {
      this.stdoutDecoder.decode();
      this.stderrDecoder.decode();
      output = new TextDecoder("utf-8", { fatal: true }).decode(this.stdout);
    }
    catch { this.failure ??= "invalid-output"; }
    try {
      const probeAfter = await hashRuntimeFile(this.probePath, 64 * 1024, false);
      if (probeAfter.sha256 !== probeBefore.sha256) {this.failure ??= "identity-changed";}
    } catch { this.failure ??= "identity-changed"; }
    return output;
  }
  private async complete(owned: ChildProcess, pid: number, probeBefore: Awaited<ReturnType<typeof hashRuntimeFile>>): Promise<ProcessResult> {
    // Let Node reap an already exited leader before checking its former group.
    if (owned.exitCode !== null || owned.signalCode !== null) {
      await waitChildClose(owned, () => this.childClosed, 100);
    }
    // Never signal after the leader identity disappears; retain group debt instead.
    await this.input.lifecycle?.stopping();
    const cleanup = await terminateAttributedGroup(pid, this.startIdentity, this.syscalls);
    if (cleanup.signalFailure) {this.failure ??= "liveness-uncertain";}
    await waitChildClose(owned, () => this.childClosed, CLEANUP_WAIT);
    const state = this.syscalls.groupState(pid);
    const group = state === "absent" ? "empty-observed" : "unconfirmed";
    const streams = this.streamsAreClosed() ? "closed" : "unconfirmed";
    if (group !== "empty-observed" || streams !== "closed" ||
        owned.exitCode === null && owned.signalCode === null) {this.failure ??= "liveness-uncertain";}
    else if (this.hasStreamError()) {this.failure ??= "invalid-output";}
    if (this.verifiedHandshake && !this.handshake.equals(this.verifiedHandshake)) {this.failure ??= "invalid-output";}
    const output = await this.readOutput(probeBefore);
    return { code: this.failure, facts: this.facts(owned, group, streams),
      handshake: this.observed, output, diagnosticTailBase64: this.diagnosticTail.toString("base64") };
  }
  private async recover(): Promise<ProcessResult> {
    this.failure ??= "spawn-failed";
    if (!this.child) {
      return { code: this.probeReady ? this.failure : "identity-changed",
        facts: this.facts(null,
        "not-started", "not-started"), handshake: null, output: "" };
    }
    // A post-spawn error must still close the private gate and account for the child.
    const gate = this.child.stdio[4];
    if (gate && typeof gate !== "number" && "end" in gate) {gate.end();}
    if (this.child.pid !== undefined) {
      try { await terminateAttributedGroup(this.child.pid, this.startIdentity, this.syscalls); }
      catch { /* Unobservable cleanup retains debt; a numeric PID alone cannot authorize a signal. */ }
      await waitChildClose(this.child, () => this.childClosed, CLEANUP_WAIT);
    }
    const group = this.child.pid !== undefined && this.syscalls.groupState(this.child.pid) === "absent" ? "empty-observed" : "unconfirmed";
    const streams = this.streamsAreClosed() ? "closed" : "unconfirmed";
    return { code: this.failure,
      facts: this.facts(this.child, group, streams),
      handshake: null, output: "", diagnosticTailBase64: this.diagnosticTail.toString("base64") };
  }
  async execute(): Promise<ProcessResult> {
  if (this.hasFailure()) {return { code: this.failure, facts: this.facts(null, "not-started", "not-started"), handshake: null, output: "" };}
  const timeout = this.input.kind.startsWith("pnpm-install-") || this.input.kind === "pnpm-peers-check" ? 120_000 : PROBE_DEADLINE;
  const deadline = new AbortController();
  void delay(timeout, undefined, { signal: deadline.signal }).then(() => {
    this.timedOut = true; this.failure ??= "deadline";
    return null;
  }, () => null);
  const onAbort = (): void => { this.cancelled = true; this.failure ??= "cancelled"; };
  this.input.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const launched = await this.launch();
    if ("code" in launched) { return launched; }
    const { owned, pid, releasePipe, probeBefore } = launched;
    await this.awaitExecution(owned, pid, releasePipe, timeout);
    return await this.complete(owned, pid, probeBefore);
  } catch {
    return await this.recover();
  } finally { deadline.abort(); this.input.signal.removeEventListener("abort", onAbort); }
}
}
export async function runManagedProbe(input: ManagedProbeInput,
  syscalls: ManagedProbeSignalSyscalls = realSignals): Promise<ProcessResult> {
  return new ManagedProbeOperation(input, syscalls).execute();
}
