import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { withoutGitRepositorySelectors } from "../../tools/git-environment.ts";

const execFileAsync = promisify(execFile);

export function poisonInheritedFixtureGitEnvironment(): () => void {
  const inherited = {
    GIT_AUTHOR_NAME: "Ambient Test Author",
    GIT_AUTHOR_EMAIL: "ambient-author@example.invalid",
    GIT_COMMITTER_NAME: "Ambient Test Committer",
    GIT_COMMITTER_EMAIL: "ambient-committer@example.invalid",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "Injected Test Identity",
  };
  const previous = new Map(Object.keys(inherited).map((key) => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function fixtureGitEnvironment(cwd: string): Promise<NodeJS.ProcessEnv> {
  const home = join(cwd, ".git", "release-freshness-home");
  const globalConfig = join(home, "global.gitconfig");
  const systemConfig = join(home, "system.gitconfig");
  await mkdir(home, { recursive: true });
  await Promise.all([writeFile(globalConfig, ""), writeFile(systemConfig, "")]);
  const environment = Object.fromEntries(
    Object.entries(withoutGitRepositorySelectors()).filter(
      ([key]) =>
        !/^(?:HOME|USERPROFILE|XDG_CONFIG_HOME|GIT_(?:(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)|CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM)))$/iu.test(
          key,
        ),
    ),
  );
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: systemConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

export async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: await fixtureGitEnvironment(cwd),
  });
  return stdout.trim();
}

export async function commitRelease(root: string, ...args: readonly string[]): Promise<void> {
  await git(
    root,
    "-c",
    "user.name=iliya",
    "-c",
    "user.email=iliyazelenkog@gmail.com",
    "commit",
    ...args,
  );
}

export async function amendFixtureIdentity(
  root: string,
  authorName: string,
  authorEmail: string,
  committerName: string,
  committerEmail: string,
): Promise<void> {
  await execFileAsync(
    "git",
    ["commit", "--amend", "--no-edit", `--author=${authorName} <${authorEmail}>`],
    {
      cwd: root,
      env: {
        ...(await fixtureGitEnvironment(root)),
        GIT_COMMITTER_NAME: committerName,
        GIT_COMMITTER_EMAIL: committerEmail,
      },
    },
  );
}
