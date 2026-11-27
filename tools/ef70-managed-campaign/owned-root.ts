import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface CampaignRoots {
  readonly root: string;
  readonly evidenceRoot: string;
  readonly runnerTemp: string;
  readonly runId: string;
  readonly runAttempt: string;
}
function required(name: string): string {
  const value = process.env[name];
  assert.ok(value && !/[\r\n\0]/u.test(value), "Missing or malformed hosted environment: " + name);
  return value;
}
function uid(): number {
  const value = process.geteuid?.();
  assert(typeof value === "number", "Hosted campaign requires a real Linux effective UID");
  return value;
}
export function ownedDirectory(path: string): void {
  assert.ok(isAbsolute(path) && resolve(path) === path, "Owned directory is not canonical");
  const stat = lstatSync(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Owned path is not a directory");
  assert.equal(realpathSync(path), path, "Owned directory traverses a symlink");
  assert.equal(stat.uid, uid(), "Directory belongs to another actor");
}
export function campaignRoots(): CampaignRoots {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.equal(required("GITHUB_ACTIONS"), "true");
  assert.equal(required("GITHUB_REPOSITORY"), "agent-teams-ai/extension-foundation");
  assert.equal(required("GITHUB_REPOSITORY_ID"), "1333298097");
  assert.equal(required("GITHUB_EVENT_NAME"), "push");
  assert.equal(required("GITHUB_REF"), "refs/heads/docs/coordinated-module-foundation-20261126");
  const runId = required("GITHUB_RUN_ID"),
    runAttempt = required("GITHUB_RUN_ATTEMPT");
  assert.match(runId, /^[1-9][0-9]*$/u);
  assert.match(runAttempt, /^[1-9][0-9]*$/u);
  const runnerTemp = realpathSync(required("RUNNER_TEMP"));
  ownedDirectory(runnerTemp);
  return {
    runnerTemp,
    runId,
    runAttempt,
    root: join(runnerTemp, "ef70-managed-real-" + runId + "-" + runAttempt),
    evidenceRoot: join(runnerTemp, "ef70-evidence-" + runId + "-" + runAttempt),
  };
}
export function initializeCampaignRoots(): CampaignRoots & { prerequisiteGeneration: string } {
  const roots = campaignRoots();
  assert.ok(
    !existsSync(roots.root) && !existsSync(roots.evidenceRoot),
    "Fresh hosted roots required",
  );
  mkdirSync(roots.root, { mode: 0o700 });
  mkdirSync(roots.evidenceRoot, { mode: 0o700 });
  ownedDirectory(roots.root);
  ownedDirectory(roots.evidenceRoot);
  const stat = lstatSync(roots.root),
    prerequisiteGeneration = randomUUID();
  writeFileSync(
    join(roots.root, "prerequisite-generation.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        ...roots,
        prerequisiteGeneration,
        device: stat.dev,
        inode: stat.ino,
        ownerUID: stat.uid,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return { ...roots, prerequisiteGeneration };
}
export function assertCampaignRoot(): CampaignRoots {
  const roots = campaignRoots();
  ownedDirectory(roots.root);
  ownedDirectory(roots.evidenceRoot);
  const path = join(roots.root, "prerequisite-generation.json"),
    stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  assert.equal(stat.uid, uid());
  assert.equal(stat.mode & 0o777, 0o600);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  const marker = value as Record<string, unknown>,
    actual = lstatSync(roots.root);
  for (const [key, expected] of Object.entries(roots)) {
    assert.equal(marker[key], expected);
  }
  assert.equal(marker["schemaVersion"], 1);
  assert.equal(marker["device"], actual.dev);
  assert.equal(marker["inode"], actual.ino);
  assert.equal(marker["ownerUID"], actual.uid);
  assert(typeof marker["prerequisiteGeneration"] === "string");
  assert.match(marker["prerequisiteGeneration"], /^[0-9a-f-]{36}$/u);
  return roots;
}
export function assertOwnedCasePath(path: string, suffix = "", mustExist = true): void {
  const { root } = assertCampaignRoot();
  assert.ok(isAbsolute(path) && resolve(path) === path, "Case path is not canonical");
  const child = relative(root, path);
  assert.ok(!child.includes(sep) && !isAbsolute(child), "Case is outside its owned root");
  assert.ok(suffix === "" || suffix === "-corepack" || suffix === "-empty-store");
  const stem = suffix ? child.slice(0, -suffix.length) : child;
  assert.ok(!suffix || child.endsWith(suffix), "Wrong case directory suffix");
  assert.match(stem, /^case-[a-z0-9][a-z0-9-]{0,63}$/u);
  if (mustExist || existsSync(path)) {
    ownedDirectory(path);
  }
}
export function assertOwnedEnvironment(environment: NodeJS.ProcessEnv): void {
  const { root } = assertCampaignRoot();
  assert.equal(environment["EF70_CAMPAIGN_ROOT"], root);
  for (const name of ["COREPACK_HOME", "pnpm_config_store_dir", "TMPDIR"]) {
    const path = environment[name];
    assert(
      typeof path === "string" && path.startsWith(root + sep),
      name + " is outside the job-owned cache root",
    );
    ownedDirectory(path);
  }
}
/** Observer credentials never reach production controller or package subprocesses. */
export function observationChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const child = { ...environment };
  for (const key of [
    "EF70_GITHUB_READ_TOKEN",
    "EF_CAMPAIGN_GITHUB_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "NODE_AUTH_TOKEN",
  ]) {
    delete child[key];
  }
  return child;
}
/** Public Actions observations use no token; frequent content reads use contents:read. */
export function observationHeaders(url: URL): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "extension-foundation-managed-campaign",
  };
  const token = process.env["EF70_GITHUB_READ_TOKEN"];
  if (
    token &&
    url.origin === "https://api.github.com" &&
    url.pathname.startsWith("/repos/agent-teams-ai/") &&
    !url.pathname.includes("/actions/")
  ) {
    assert(!/[\r\n\0]/u.test(token), "Invalid observer credential transport");
    headers["Authorization"] = "Bearer " + token;
  }
  return headers;
}
