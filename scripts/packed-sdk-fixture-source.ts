import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./pack-test-support.mjs";
const packageName = "sdk-packed-fixture";
export function fixtureArtifactBaseline(version: string) {
  return {
    schemaVersion: 1,
    packageName,
    packageVersion: version,
    status: version === "1.0.0" ? "supported" : "release-candidate",
    wildcardExports: [
      {
        exportPath: "./data/*",
        targetPattern: "dist/data/*",
        members: [...(version === "1.1.0" ? ["dist/data/extra.txt"] : []), "dist/data/fixture.txt"],
      },
    ],
    jsonSchemas: [],
  };
}

export async function addFixtureReleaseSurface(root: string, compiler: string): Promise<void> {
  await writeFile(
    join(root, "pkg/src/index.ts"),
    "export function stable(value: string): string { return value; }\n" +
      "export function added(value: string): string { return value; }\n",
  );
  await runCommand(process.execPath, [compiler, "--project", "pkg/tsconfig.json"], root);
  await writeFile(join(root, "pkg/dist/data/extra.txt"), "additional disposable artifact\n");
  await writeFile(
    join(root, ".changeset/fixture-minor.md"),
    `---\n"${packageName}": minor\n---\n\nAdd a typed function and data member.\n`,
  );
}

export async function checkpoint(root: string): Promise<void> {
  await runCommand("git", ["init", "--quiet"], root);
  await runCommand(
    "git",
    [
      "add",
      "pkg",
      "package.json",
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      "architecture/metadata-root.json",
    ],
    root,
  );
  await runCommand(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    root,
  );
}

export function fixtureMetadataRoot() {
  return {
    schemaVersion: "foundation:sdk-growth:metadata-root:1",
    kind: "non-release-metadata-root",
    packageName: "sdk-fixture-root",
    rootPath: ".",
    manifestPath: "package.json",
    decisionId: "ROOT-1",
    ownerRef: "fixture/sdk-owner",
    releaseHistory: "none",
  };
}

export async function readFixtureGrowthConfig(): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(
    await readFile(
      new URL("../architecture/contracts/sdk-growth-v2/valid.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(
    typeof parsed === "object" &&
      parsed !== null &&
      "packages" in parsed &&
      Array.isArray(parsed.packages),
  );
  const first: unknown = parsed.packages[0];
  assert.ok(typeof first === "object" && first !== null);
  const config = Object.fromEntries(Object.entries(parsed));
  config.governanceConfigPath = "governance-architecture-decisions.yaml";
  const remaining: unknown[] = parsed.packages.slice(1);
  config.packages = [
    { ...first, nonTypeExports: [{ exportPath: "./data/*", kind: "wildcard" }] },
    ...remaining,
  ];
  return config;
}
