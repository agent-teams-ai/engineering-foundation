import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const secretCanary = "AGENT_TEAMS_PACKAGE_SECRET_CANARY_DO_NOT_PUBLISH_7A13D6C4";
const commandMaxBufferBytes = 16 * 1024 * 1024;
const commandTerminationSignal = "SIGKILL";
const secretPatterns = [
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bghp_[A-Za-z0-9]{36,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u
];

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value).toSorted(([left], [right]) =>
    compareStrings(left, right)
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

export function canonicalDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function syntheticDigest(character) {
  return `sha256:${character.repeat(64)}`;
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function createPnpmRunner() {
  const entrypoint = process.env.npm_execpath;
  const executable = entrypoint === undefined ? "pnpm" : process.execPath;
  return async (args, cwd) =>
    runCommand(executable, entrypoint === undefined ? args : [entrypoint, ...args], cwd);
}

export const localRegistryInstallQualification = Object.freeze({
  requiredBeforeRelease: true,
  status: "not-proven-by-tarball-e2e",
  summary:
    "The package check installs a file tarball. A separate hermetic npm-compatible registry E2E must prove registry publication and installation before release."
});

class CommandExecutionError extends Error {
  constructor(message, input) {
    super(message, { cause: input.cause });
    this.name = "CommandExecutionError";
    this.code = input.code;
    this.command = input.command;
    this.killed = input.killed;
    this.signal = input.signal;
    this.stderr = input.stderr;
    this.stdout = input.stdout;
    this.timedOut = input.timedOut;
  }
}

function appendOutput(output, chunk, streamName) {
  const nextLength = output.length + chunk.length;
  if (nextLength > commandMaxBufferBytes) {
    throw new Error(`${streamName} exceeded ${commandMaxBufferBytes} bytes.`);
  }
  output.push(chunk);
}

function commandError(input) {
  const detail = [
    input.timedOut ? `timed out after ${input.timeoutMs}ms` : undefined,
    input.signal === null ? undefined : `received ${input.signal}`,
    input.code === null ? undefined : `exited with code ${input.code}`,
    input.cause instanceof Error ? input.cause.message : undefined
  ]
    .filter((value) => value !== undefined)
    .join(", ");
  return new CommandExecutionError(
    `Command failed: ${input.command} ${input.args.join(" ")}${detail === "" ? "" : ` (${detail})`}.`,
    input
  );
}

function waitForClose(child) {
  return new Promise((resolve) => {
    child.once("close", resolve);
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
    child.once("error", () => {
      resolve({ code: null, signal: null });
    });
  });
}

async function terminateWindowsProcessTree(pid) {
  await new Promise((resolve) => {
    const terminator = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    terminator.once("error", resolve);
    terminator.once("close", resolve);
  });
}

async function terminateCommandTree(child) {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(child.pid);
    return;
  }
  try {
    process.kill(-child.pid, commandTerminationSignal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

export async function runCommand(command, args, cwd, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Command timeout must be a positive safe integer.");
  }
  if (options.signal?.aborted === true) {
    throw commandError({
      args,
      cause: options.signal.reason,
      code: null,
      command,
      killed: false,
      signal: null,
      stderr: "",
      stdout: "",
      timedOut: false,
      timeoutMs
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    const close = waitForClose(child);
    const exit = waitForExit(child);
    let cause;
    let completing = false;
    let forceTerminationRequested = false;
    let terminationRequested = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      requestForcedTermination(new Error(`Command exceeded its ${timeoutMs}ms deadline.`));
    }, timeoutMs);

    const onAbort = () => {
      requestForcedTermination(options.signal?.reason ?? new Error("Command was aborted."));
    };

    function requestForcedTermination(error) {
      forceTerminationRequested = true;
      cause ??= error;
      void requestTermination();
    }

    async function requestTermination() {
      if (terminationRequested) {
        return;
      }
      terminationRequested = true;
      try {
        await terminateCommandTree(child);
      } catch (error) {
        cause ??= error;
      }
    }

    async function complete() {
      if (completing) {
        return;
      }
      completing = true;
      const result = await exit;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      await requestTermination();
      await close;
      const text = {
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8")
      };
      if (cause !== undefined || timedOut || result.code !== 0) {
        reject(
          commandError({
            args,
            cause,
            code: result.code,
            command,
            killed: forceTerminationRequested || result.signal !== null,
            signal: result.signal,
            ...text,
            timedOut,
            timeoutMs
          })
        );
        return;
      }
      resolve(text);
    }

    child.stdout.on("data", (chunk) => {
      try {
        appendOutput(stdout, chunk, "stdout");
      } catch (error) {
        requestForcedTermination(error);
      }
    });
    child.stderr.on("data", (chunk) => {
      try {
        appendOutput(stderr, chunk, "stderr");
      } catch (error) {
        requestForcedTermination(error);
      }
    });
    child.once("error", (error) => {
      cause ??= error;
      void complete();
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    void complete();
  });
}

export async function captureFailure(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }
}

export async function assertSecretCanaryAbsent(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await assertSecretCanaryAbsent(path);
      continue;
    }
    if (entry.isFile()) {
      await assertFileHasNoSecret(path);
    }
  }
}

async function assertFileHasNoSecret(path) {
  const content = await readFile(path);
  const text = content.toString("utf8");
  if (
    content.includes(Buffer.from(secretCanary)) ||
    secretPatterns.some((pattern) => pattern.test(text))
  ) {
    throw new Error(`Secret-like content leaked into package tarball: ${path}.`);
  }
}

export function registryLockfile(version, integrity) {
  const packageName = "@agent-teams/engineering-foundation";
  const packageKey = `${packageName}@${version}`;
  return `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      '${packageName}':
        specifier: ${version}
        version: ${version}

packages:

  '${packageKey}':
    resolution: {integrity: ${integrity}}

snapshots:

  '${packageKey}': {}
`;
}
