import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  assertSecretCanaryAbsent,
  runCommand
} from "./pack-test-support.mjs";

const forbiddenEntries = [
  "/.git/",
  "/node_modules/",
  "/src/",
  "/tests/",
  ".env",
  "auth.json",
  "foundation-link.json",
  "/secret-fixtures/"
];

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_500;
const generatedPackageEntries = new Set(["dist", "node_modules", "tsconfig.tsbuildinfo"]);

export function assertArchiveListing(listing, requiredArtifactPaths) {
  for (const forbidden of forbiddenEntries) {
    if (listing.includes(forbidden)) {
      throw new Error(`Forbidden package entry detected: ${forbidden}`);
    }
  }
  const entries = new Set(listing.split(/\r?\n/u));
  if (entries.size > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`Package contains too many entries: ${entries.size}.`);
  }
  const requiredEntries = [
    "package/package.json",
    "package/LICENSE",
    "package/README.md",
    ...requiredArtifactPaths.map((path) => `package/${path}`)
  ];
  for (const required of requiredEntries) {
    if (!entries.has(required)) {
      throw new Error(`Required package entry missing: ${required}`);
    }
  }
  const requiredDirectories = new Set(["package/"]);
  for (const required of requiredEntries) {
    let boundary = required.lastIndexOf("/");
    while (boundary >= "package".length) {
      requiredDirectories.add(`${required.slice(0, boundary)}/`);
      boundary = required.lastIndexOf("/", boundary - 1);
    }
  }
  for (const entry of entries) {
    if (
      entry.length > 0 &&
      !requiredDirectories.has(entry) &&
      !entry.startsWith("package/dist/") &&
      !requiredEntries.includes(entry)
    ) {
      throw new Error(`Package entry is outside the release allowlist: ${entry}`);
    }
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function assertNoSpecialTarEntries(verboseListing) {
  for (const line of verboseListing.split(/\r?\n/u).filter(Boolean)) {
    const type = line[0];
    if (type !== "-" && type !== "d") {
      throw new Error(`Package contains a prohibited special tar entry: ${line}`);
    }
  }
}

export function assertArchiveSafety({ archiveBytes, listing, requiredArtifactPaths, verboseListing }) {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Package archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`);
  }
  assertArchiveListing(listing, requiredArtifactPaths);
  assertNoSpecialTarEntries(verboseListing);
}

function shouldCopyPackagePath(path) {
  return !generatedPackageEntries.has(basename(path));
}

export async function createCleanBuildStage(input, label) {
  const stageRoot = join(
    input.temporaryRoot,
    `clean-build-${input.artifactLabel ?? "package"}-${label}`,
  );
  const packageRoot = join(stageRoot, "packages", basename(input.packageRoot));
  await mkdir(dirname(packageRoot), { recursive: true });
  await cp(input.packageRoot, packageRoot, {
    filter: shouldCopyPackagePath,
    recursive: true
  });
  await copyFile(join(input.repositoryRoot, "LICENSE"), join(packageRoot, "LICENSE"));
  for (const supportRoot of input.supportPackageRoots ?? []) {
    const stagedSupportRoot = join(stageRoot, "packages", basename(supportRoot));
    await cp(supportRoot, stagedSupportRoot, {
      filter: shouldCopyPackagePath,
      recursive: true,
    });
    await copyFile(
      join(input.repositoryRoot, "LICENSE"),
      join(stagedSupportRoot, "LICENSE"),
    );
    await symlink(
      join(supportRoot, "node_modules"),
      join(stagedSupportRoot, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  await copyFile(
    join(input.repositoryRoot, "pnpm-workspace.yaml"),
    join(stageRoot, "pnpm-workspace.yaml")
  );
  await symlink(
    join(input.packageRoot, "node_modules"),
    join(packageRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await symlink(
    join(input.repositoryRoot, "node_modules"),
    join(stageRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await input.runBuild(packageRoot);
  return Object.freeze({ packageRoot, stageRoot });
}

async function createArtifact(input, stage) {
  const destination = join(stage.stageRoot, "pack");
  await mkdir(destination, { recursive: true });
  await input.runPnpm(["pack", "--pack-destination", destination], stage.packageRoot);
  const archiveName = (await readdir(destination)).find((name) => name.endsWith(".tgz"));
  if (archiveName === undefined) {
    throw new Error("pnpm pack did not produce a tarball.");
  }
  return { archiveName, archivePath: join(destination, archiveName) };
}

export async function packAndInspectArtifact(input) {
  const first = await createArtifact(input, await createCleanBuildStage(input, "a"));
  const second = await createArtifact(input, await createCleanBuildStage(input, "b"));
  if ((await sha256(first.archivePath)) !== (await sha256(second.archivePath))) {
    throw new Error("Two clean package builds did not produce byte-identical tarballs.");
  }
  const { stdout: listing } = await runCommand("tar", ["-tzf", first.archivePath], input.temporaryRoot);
  const { stdout: verboseListing } = await runCommand(
    "tar",
    ["-tvzf", first.archivePath],
    input.temporaryRoot
  );
  assertArchiveSafety({
    archiveBytes: await readFile(first.archivePath),
    listing,
    requiredArtifactPaths: input.requiredArtifactPaths,
    verboseListing,
  });

  const extractedRoot = join(
    input.temporaryRoot,
    `extracted-${input.artifactLabel ?? "package"}`,
  );
  await mkdir(extractedRoot, { recursive: true });
  await runCommand("tar", ["-xzf", first.archivePath, "-C", extractedRoot], input.temporaryRoot);
  await assertSecretCanaryAbsent(extractedRoot);

  return Object.freeze({
    archiveFileSpecifier: `file:${first.archivePath.replaceAll("\\", "/")}`,
    archiveName: first.archiveName,
    archivePath: first.archivePath
  });
}
