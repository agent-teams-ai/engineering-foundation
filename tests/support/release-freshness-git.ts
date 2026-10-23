import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
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
        ...process.env,
        GIT_COMMITTER_NAME: committerName,
        GIT_COMMITTER_EMAIL: committerEmail,
      },
    },
  );
}
