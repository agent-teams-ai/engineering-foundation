import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePublishedVersion } from "./release-publish-registry-version.mjs";

type ChangesetRelease = {
  changesets: string[];
  name: string;
  newVersion: string;
  oldVersion: string;
  type: string;
};

export type ChangesetsReleasePlan = {
  releases: ChangesetRelease[];
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
  exactKeys(value, ["changesets", "name", "newVersion", "oldVersion", "type"], label);
  if (
    typeof value.name !== "string" || value.name === "" ||
    typeof value.type !== "string" || !["major", "minor", "patch", "none"].includes(value.type) ||
    typeof value.oldVersion !== "string" || parsePublishedVersion(value.oldVersion) === undefined ||
    typeof value.newVersion !== "string" || parsePublishedVersion(value.newVersion) === undefined ||
    !Array.isArray(value.changesets) ||
    value.changesets.some((entry) => typeof entry !== "string" || entry === "") ||
    new Set(value.changesets).size !== value.changesets.length
  ) {
    fail(`${label} is not an exact supported Changesets release.`);
  }
  return Object.freeze({
    changesets: Object.freeze([...value.changesets]) as readonly string[],
    name: value.name,
    newVersion: value.newVersion,
    oldVersion: value.oldVersion,
    type: value.type,
  }) as ChangesetRelease;
}

export function plannedReleaseVersions(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value) || !Array.isArray(value.releases)) {
    fail("Changesets release plan has an unexpected inventory shape.");
  }
  const releases = value.releases.map(parseRelease);
  if (new Set(releases.map(({ name }) => name)).size !== releases.length) {
    fail("Changesets release plan contains duplicate package names.");
  }
  return Object.freeze(Object.fromEntries(releases.map(({ name, newVersion }) => [name, newVersion])));
}

function executeChangesetStatus(cwd: string, outputPath: string): Promise<void> {
  const require = createRequire(import.meta.url);
  const changesetsCli = require.resolve("@changesets/cli/bin.js");
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [changesetsCli, "status", "--output", outputPath],
      { cwd, timeout: 30_000 },
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

export async function collectPlannedReleaseVersions({
  cwd = process.cwd(),
  runChangesetStatus = executeChangesetStatus,
  temporaryRoot = tmpdir(),
}: Readonly<{
  cwd?: string;
  runChangesetStatus?: ExecuteChangesetStatus;
  temporaryRoot?: string;
}> = {}): Promise<Readonly<Record<string, string>>> {
  const root = await mkdtemp(join(temporaryRoot, "npm-package-bootstrap-release-plan-"));
  const outputPath = join(root, "release-plan.json");
  try {
    await runChangesetStatus(cwd, outputPath);
    return plannedReleaseVersions(JSON.parse(await readFile(outputPath, "utf8")));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
