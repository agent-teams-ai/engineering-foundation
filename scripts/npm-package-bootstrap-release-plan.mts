import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePublishedVersion } from "./release-publish-registry-version.mjs";
import { withoutGitRepositorySelectors } from "../tools/git-environment.ts";

export type ChangesetRelease = {
  readonly changesets: readonly string[];
  readonly name: string;
  readonly newVersion?: string;
  readonly oldVersion?: string;
  readonly type: "major" | "minor" | "patch" | "none";
};

export type ChangesetsReleasePlan = {
  readonly changesets: readonly {
    readonly id: string;
    readonly summary: string;
    readonly releases: readonly { readonly name: string; readonly type: "major" | "minor" | "patch" }[];
  }[];
  readonly releases: readonly ChangesetRelease[];
  readonly preState?: Readonly<Record<string, unknown>>;
};

type ExecuteChangesetStatus = (cwd: string, outputPath: string) => Promise<void>;

function fail(message: string): never {
  throw new Error(`npm package bootstrap refused: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).toSorted().join("\0") !== [...expected].toSorted().join("\0")
  ) {
    fail(`${label} has an unexpected Changesets inventory shape.`);
  }
}

function parseRelease(value: unknown, index: number): ChangesetRelease {
  const label = `Changesets release[${index}]`;
  if (!isRecord(value)) { fail(`${label} must be an object.`); }
  const absentVersions = value.type === "none" && !Object.hasOwn(value, "oldVersion") && !Object.hasOwn(value, "newVersion");
  exactKeys(value, absentVersions ? ["changesets", "name", "type"] : ["changesets", "name", "newVersion", "oldVersion", "type"], label);
  if (
    typeof value.name !== "string" || value.name === "" ||
    typeof value.type !== "string" || !["major", "minor", "patch", "none"].includes(value.type) ||
    (!absentVersions && (typeof value.oldVersion !== "string" || parsePublishedVersion(value.oldVersion) === undefined ||
      typeof value.newVersion !== "string" || parsePublishedVersion(value.newVersion) === undefined)) ||
    (value.type === "none" && value.oldVersion !== value.newVersion) ||
    !Array.isArray(value.changesets) ||
    value.changesets.some((entry) => typeof entry !== "string" || entry === "") ||
    new Set(value.changesets).size !== value.changesets.length
  ) {
    fail(`${label} is not an exact supported Changesets release.`);
  }
  return Object.freeze({
    changesets: Object.freeze([...value.changesets]) as readonly string[],
    name: value.name,
    ...(absentVersions ? {} : { newVersion: value.newVersion, oldVersion: value.oldVersion }),
    type: value.type,
  }) as ChangesetRelease;
}

export function normalizeChangesetsReleasePlan(value: unknown): ChangesetsReleasePlan {
  if (!isRecord(value) || !Array.isArray(value.releases)) {
    fail("Changesets release plan has an unexpected inventory shape.");
  }
  const releases = value.releases.map(parseRelease);
  if (new Set(releases.map(({ name }) => name)).size !== releases.length) {
    fail("Changesets release plan contains duplicate package names.");
  }
  if (!Array.isArray(value.changesets)) { fail("Changesets plan must contain its complete intent inventory."); }
  const changesets = value.changesets.map((entry, index) => {
    const label = `Changesets intent[${index}]`;
    exactKeys(entry, ["id", "releases", "summary"], label);
    if (typeof entry.id !== "string" || entry.id === "" || typeof entry.summary !== "string" || !Array.isArray(entry.releases)) {
      fail(`${label} has malformed intent content.`);
    }
    const requests = entry.releases.map((request: unknown) => {
      exactKeys(request, ["name", "type"], label);
      if (typeof request.name !== "string" || request.name === "" || !["major", "minor", "patch"].includes(String(request.type))) {
        fail(`${label} has an unsupported package request.`);
      }
      return Object.freeze({ name: request.name, type: request.type as "major" | "minor" | "patch" });
    });
    if (new Set(requests.map(request => request.name)).size !== requests.length) { fail(`${label} repeats a package.`); }
    return Object.freeze({ id: entry.id, summary: entry.summary, releases: Object.freeze(requests) });
  });
  if (new Set(changesets.map(entry => entry.id)).size !== changesets.length) { fail("Changesets plan repeats an intent."); }
  if (value.preState !== undefined && !isRecord(value.preState)) { fail("Changesets plan has an invalid prerelease state."); }
  return Object.freeze({ changesets: Object.freeze(changesets), releases: Object.freeze(releases),
    ...(value.preState === undefined ? {} : { preState: Object.freeze(structuredClone(value.preState)) }) });
}

export function plannedReleaseVersions(value: unknown): Readonly<Record<string, string>> {
  const plan = normalizeChangesetsReleasePlan(value);
  return Object.freeze(Object.fromEntries(plan.releases.flatMap(({ name, newVersion }) => newVersion === undefined ? [] : [[name, newVersion]])));
}

function executeChangesetStatus(cwd: string, outputPath: string, cliEntrypoint?: string, nodeExecutable = process.execPath): Promise<void> {
  const require = createRequire(import.meta.url);
  const changesetsCli = cliEntrypoint ?? require.resolve("@changesets/cli/bin.js");
  return new Promise((resolve, reject) => {
    execFile(
      nodeExecutable,
      [changesetsCli, "status", "--output", outputPath],
      { cwd, env: withoutGitRepositorySelectors(), timeout: 30_000 },
      (error) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
}

export async function collectChangesetsReleasePlan({
  cwd = process.cwd(),
  runChangesetStatus,
  temporaryRoot = tmpdir(),
  cliEntrypoint,
  nodeExecutable,
}: Readonly<{
  cwd?: string;
  runChangesetStatus?: ExecuteChangesetStatus;
  temporaryRoot?: string;
  cliEntrypoint?: string;
  nodeExecutable?: string;
}> = {}): Promise<ChangesetsReleasePlan> {
  const root = await mkdtemp(join(temporaryRoot, "npm-package-bootstrap-release-plan-"));
  const outputPath = join(root, "release-plan.json");
  try {
    await (runChangesetStatus ?? ((sourceRoot, output) => executeChangesetStatus(sourceRoot, output, cliEntrypoint, nodeExecutable)))(cwd, outputPath);
    return normalizeChangesetsReleasePlan(JSON.parse(await readFile(outputPath, "utf8")));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

export async function collectPlannedReleaseVersions(options: Parameters<typeof collectChangesetsReleasePlan>[0] = {}): Promise<Readonly<Record<string, string>>> {
  return plannedReleaseVersions(await collectChangesetsReleasePlan(options));
}
