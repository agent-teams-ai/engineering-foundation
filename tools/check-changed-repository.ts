import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { constants } from "node:os";
import { basename, resolve } from "node:path";
import { resolveQualificationExecutables } from "./executable-policy.mts";
import { withoutGitRepositorySelectors } from "./git-environment.ts";
import { assertExplicitSourceGitAuthority, assertOwnedProfileRoot } from "./profile-root.mts";
import { repositoryRoot } from "./runtime-policy.mts";

function retainOutput(path: string): { write: (chunk: Buffer) => void; close: () => void } {
  const descriptor = openSync(path, "wx", 0o600);
  const truncated = Buffer.from("\n[Diagnostic output truncated at 1 MiB.]\n");
  let remaining = 1024 * 1024 - truncated.length;
  const failed = (error: unknown): void => {
    remaining = -1;
    process.stderr.write(`Changed-check diagnostic retention failed: ${error instanceof Error ? error.message : String(error)}\n`);
  };
  return {
    write(chunk) {
      if (remaining < 0) { return; }
      try {
        const admitted = chunk.subarray(0, remaining);
        appendFileSync(descriptor, admitted);
        remaining -= admitted.length;
        if (admitted.length < chunk.length) {
          appendFileSync(descriptor, truncated);
          remaining = -1;
        }
      } catch (error) { failed(error); }
    },
    close() { try { closeSync(descriptor); } catch (error) { failed(error); } }
  };
}

async function run(node: string, operation: "install" | "check", environment: NodeJS.ProcessEnv,
  retain: (chunk: Buffer) => void): Promise<number> {
  const child = spawn(node, [resolve(repositoryRoot, "tools/dev.mts"), "--profile", "node", operation], {
    cwd: repositoryRoot, env: environment, shell: false, stdio: ["inherit", "pipe", "pipe"]
  });
  child.stdout.on("data", retain).pipe(process.stdout, { end: false });
  child.stderr.on("data", retain).pipe(process.stderr, { end: false });
  let interrupted: NodeJS.Signals | null = null;
  const interrupt = (signal: NodeJS.Signals): void => { interrupted = signal; child.kill(signal); };
  const forwardInterrupt = (): void => { interrupt("SIGINT"); };
  const forwardTermination = (): void => { interrupt("SIGTERM"); };
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  try {
    return await new Promise<number>((_resolve, reject) => {
      child.once("error", reject);
      // Close waits for the inherited output pipes to drain before profile release.
      child.once("close", (code, signal) => {
        const cancellation = interrupted ?? signal;
        _resolve(cancellation === null ? code ?? 1 : 128 + constants.signals[cancellation]);
      });
    });
  } finally {
    process.removeListener("SIGINT", forwardInterrupt);
    process.removeListener("SIGTERM", forwardTermination);
  }
}

const authority = await assertExplicitSourceGitAuthority(repositoryRoot);
const runtime = await resolveQualificationExecutables("node");
const temporary = resolve(authority.sourceRoot, ".worker-tmp");
await mkdir(temporary, { recursive: true });
if (await realpath(temporary) !== temporary) {
  throw new Error("Changed repository checks require an owned temporary parent.");
}
const profiles = resolve(temporary, "profiles");
await mkdir(profiles, { recursive: true });
const prefix = await assertOwnedProfileRoot(resolve(profiles, "check-changed-"), authority.sourceRoot);
const profileRoot = await mkdtemp(prefix);
const environment: NodeJS.ProcessEnv = {
  ...withoutGitRepositorySelectors(),
  AGENT_TEAMS_FOUNDATION_SOURCE_ROOT: authority.sourceRoot,
  AGENT_TEAMS_FOUNDATION_SOURCE_SHA: authority.sourceCommit,
  AGENT_TEAMS_FOUNDATION_PROFILE_ROOT: profileRoot,
  AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "node",
  AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: runtime.node,
  NX_DAEMON: "false"
};
let output: ReturnType<typeof retainOutput> | undefined;
let exitCode = 1;
try {
  // Keep only bounded diagnostics outside the disposable source copy. These are
  // mutable command feedback, not a qualified C1 report or a reusable profile.
  output = retainOutput(resolve(temporary, `${basename(profileRoot)}.log`));
  output.write(Buffer.from(`Source: ${authority.sourceCommit}\nProfile: ${profileRoot}\n`));
  const installed = await run(runtime.node, "install", environment, output.write);
  exitCode = installed === 0 ? await run(runtime.node, "check", environment, output.write) : installed;
} catch (error) {
  output?.write(Buffer.from(`Execution failed: ${error instanceof Error ? error.message : String(error)}\n`));
  throw error;
} finally {
  try {
    await assertOwnedProfileRoot(profileRoot, authority.sourceRoot);
    await rm(profileRoot, { recursive: true, force: true });
  } catch (error) {
    const message = `Changed-check profile cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`;
    process.stderr.write(message);
    output?.write(Buffer.from(message));
    if (exitCode === 0) { exitCode = 1; }
  }
  output?.close();
  process.exitCode = exitCode;
}
