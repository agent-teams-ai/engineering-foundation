import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { constants } from "node:os";
import { resolve } from "node:path";
import { resolveQualificationExecutables } from "./executable-policy.mts";
import { withoutGitRepositorySelectors } from "./git-environment.ts";
import { assertExplicitSourceGitAuthority, assertOwnedProfileRoot } from "./profile-root.mts";
import { repositoryRoot } from "./runtime-policy.mts";

async function run(node: string, operation: "install" | "check", environment: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(node, [resolve(repositoryRoot, "tools/dev.mts"), "--profile", "node", operation], {
    cwd: repositoryRoot, env: environment, shell: false, stdio: "inherit"
  });
  let interrupted: NodeJS.Signals | null = null;
  const interrupt = (signal: NodeJS.Signals): void => { interrupted = signal; child.kill(signal); };
  const forwardInterrupt = (): void => { interrupt("SIGINT"); };
  const forwardTermination = (): void => { interrupt("SIGTERM"); };
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  try {
    return await new Promise<number>((_resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
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
  AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: runtime.node
};
const installed = await run(runtime.node, "install", environment);
process.exitCode = installed === 0 ? await run(runtime.node, "check", environment) : installed;
