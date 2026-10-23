import { type ChildProcess } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";
import { consumerTimeMilliseconds } from "./node-consumer-clock.js";
import { hashRuntimeFile, type RuntimeImage } from "./node-managed-runtime-identity.js";
import {
  type ProcessFacts,
  type RuntimeRefusalCode,
  type RuntimeTuple,
} from "../application/ports/managed-runtime.js";
export const MAX_OUTPUT = 1024 * 1024;
export const MAX_HANDSHAKE = 8 * 1024;
export const PROBE_DEADLINE = 30_000;
export const CLEANUP_WAIT = 1000;
export const PROBE_SHA256 = "f58760bde33f2869917e747e19c7a78459f5df6a0c9a7cf078339e3620ddd26b";
export const scrubbedEnvironment = (cwd: string): NodeJS.ProcessEnv => ({
  CI: "true",
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
  TMPDIR: cwd,
  XDG_CACHE_HOME: cwd,
  XDG_CONFIG_HOME: cwd,
  XDG_DATA_HOME: cwd,
  NODE_COMPILE_CACHE: join(cwd, "node-compile-cache"),
  npm_config_userconfig: join(cwd, "user.npmrc"),
  npm_config_globalconfig: join(cwd, "global.npmrc"),
  npm_config_manage_package_manager_versions: "false",
  npm_config_engine_strict: "true",
  npm_config_strict_peer_dependencies: "true",
  COREPACK_ENABLE_NETWORK: "0",
});
export interface ProcessResult {
  readonly code: RuntimeRefusalCode | null;
  readonly facts: ProcessFacts;
  readonly handshake: RuntimeTuple | null;
  readonly output: string;
  readonly diagnosticTailBase64?: string;
}
export function retainTail(previous: Buffer, chunk: Buffer): Buffer {
  if (chunk.length >= 4096) {
    return Buffer.from(chunk.subarray(-4096));
  }
  return Buffer.concat([previous, chunk]).subarray(-4096);
}
export async function procStart(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const right = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return right[19] ?? "";
}
function groupState(pgid: number): "absent" | "present" | "unknown" {
  try {
    process.kill(-pgid, 0);
    return "present";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return "absent";
    }
    return "unknown";
  }
}
export interface ManagedProbeSignalSyscalls {
  groupState(pgid: number): "absent" | "present" | "unknown";
  signalGroup(pgid: number, signal: NodeJS.Signals): void;
}
export const realSignals: ManagedProbeSignalSyscalls = {
  groupState,
  signalGroup: (pgid, signal) => {
    process.kill(-pgid, signal);
  },
};
async function waitGroup(
  pgid: number,
  milliseconds: number,
  syscalls: ManagedProbeSignalSyscalls,
): Promise<"absent" | "present" | "unknown"> {
  const until = consumerTimeMilliseconds() + milliseconds;
  let state = syscalls.groupState(pgid);
  while (state === "present" && consumerTimeMilliseconds() < until) {
    await delay(25);
    state = syscalls.groupState(pgid);
  }
  return state;
}
export function waitChildClose(
  child: ChildProcess,
  alreadyClosed: () => boolean,
  milliseconds: number,
): Promise<boolean> {
  if (alreadyClosed()) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onClose = (): void => {
      finish(true);
    };
    const timer = new AbortController();
    void delay(milliseconds, undefined, { signal: timer.signal }).then(
      () => {
        finish(false);
        return null;
      },
      () => null,
    );
    const finish = (closed: boolean): void => {
      timer.abort();
      child.removeListener("close", onClose);
      resolve(closed);
    };
    child.once("close", onClose);
  });
}
export async function verifyHandshake(
  bytes: Buffer,
  image: RuntimeImage,
  expected: RuntimeTuple,
  pid: number,
  startIdentity: string | null,
): Promise<RuntimeTuple> {
  const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!line.endsWith("\n") || line.indexOf("\n") !== line.length - 1) {
    throw new Error("handshake framing");
  }
  const value: unknown = parseStrictJson(line.slice(0, -1));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("handshake shape");
  }
  const h = value as Record<string, unknown>;
  if (
    Object.keys(h).toSorted().join(",") !== "architecture,execPath,platform,version" ||
    h.execPath !== image.nodePath ||
    h.version !== expected.nodeVersion ||
    h.platform !== "linux" ||
    h.architecture !== "x64"
  ) {
    throw new Error("handshake mismatch");
  }
  const runningPath = await realpath(`/proc/${pid}/exe`);
  const running = await hashRuntimeFile(runningPath, 256 * 1024 * 1024, true);
  if (
    JSON.stringify(running) !== JSON.stringify(image.node) ||
    (await procStart(pid)) !== startIdentity
  ) {
    throw new Error("running executable mismatch");
  }
  return { ...expected, nodeVersion: h.version };
}
export async function terminateAttributedGroup(
  pid: number,
  startIdentity: string | null,
  syscalls: ManagedProbeSignalSyscalls,
): Promise<{
  state: "absent" | "present" | "unknown";
  signalFailure: boolean;
}> {
  const attributable = async (): Promise<boolean> => {
    if (startIdentity === null || startIdentity === "") {
      return false;
    }
    try {
      return (await procStart(pid)) === startIdentity;
    } catch {
      return false;
    }
  };
  let state = syscalls.groupState(pid);
  let signalFailure = false;
  if (state === "present" && (await attributable())) {
    try {
      syscalls.signalGroup(pid, "SIGTERM");
    } catch (error) {
      signalFailure = (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    state = await waitGroup(pid, CLEANUP_WAIT, syscalls);
    if (state === "present" && (await attributable())) {
      try {
        syscalls.signalGroup(pid, "SIGKILL");
      } catch (error) {
        signalFailure ||= (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
      state = await waitGroup(pid, CLEANUP_WAIT, syscalls);
    }
  }
  return { state, signalFailure };
}
/** Fixed probe only; no ambient command, argv or environment enters this boundary. */
export interface ManagedProbeInput {
  readonly image: RuntimeImage;
  readonly expected: RuntimeTuple;
  readonly cwd: string;
  readonly kind:
    | "node-identity"
    | "pnpm-version"
    | "pnpm-install-prepare"
    | "pnpm-install-frozen-offline"
    | "pnpm-peers-check";
  readonly signal: AbortSignal;
  readonly lifecycle?: {
    spawning(): Promise<void>;
    running(child: {
      readonly pid: number;
      readonly start: string;
      readonly pgid: number;
    }): Promise<void>;
    stopping(): Promise<void>;
  };
}
