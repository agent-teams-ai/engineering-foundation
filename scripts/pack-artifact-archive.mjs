import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Source-only bootstrap preflight does not inspect an archive or require a build.
// Archive operations use the same synchronous codec as the published adapter.
/** @returns {typeof import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/native-transition-archive.js")} */
function archiveCodec() {
  return require("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/native-transition-archive.js");
}

export function portableEntryIdentity(entry) {
  return archiveCodec().portableEntryIdentity(entry);
}

const forbiddenEntries = [
  "/.git/", "/node_modules/", "/src/", "/tests/", ".env", "auth.json",
  "foundation-link.json", "/secret-fixtures/",
];
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_ENTRIES = 2_500;
const PACKAGE_MAX_ARCHIVE_ENTRIES = Object.freeze({
  // Full Foundation inventory: 2,780 actual files: the qualified shared-native
  // inventory of 2,710 plus the repository-agent-workflow/v2 and
  // workspace-dependency-declarations/v2 schemas, plus 52 compiled artifacts
  // from the 13 check-changed successor modules (the v2 policy loaders and
  // parser, mutable input custody, the mutable and qualified check runners,
  // the check-changed model, policies, ports and use case; four artifacts per
  // module, while the add/add repository-agent-workflow/v2 schema resolves to
  // the single union superset file already counted), plus 4 compiled artifacts
  // from the mutable-custody contained-file-reader port module, plus eight
  // compiled artifacts from architecture-decision-baseline-replacement.ts and
  // git-index-snapshot.ts merged from the qualified main inventory, plus four
  // compiled artifacts (.js, .js.map, .d.ts, .d.ts.map) from the private
  // configuration-input/application/static-host-command.ts declaration lexer.
  // The shared native transition adds 36 compiled artifacts from nine ordinary .ts modules and one request
  // schema to the previously qualified 2,673-file inventory (+37). Earlier growth:
  // the quality-gate-runner v2 schema and 32 compiled artifacts because eight TypeScript
  // modules each emit .js, .js.map, .d.ts, and .d.ts.map under the strict
  // package tsconfig, plus 16 artifacts for the native TypeScript adapter
  // (six new modules minus two obsolete modules). The previous baseline includes
  // the four internal validation-reporting/process-failure-facts artifacts
  // (.d.ts, .d.ts.map, .js, .js.map) and the findings baseline, source graph
  // and ratchet modules (.d.ts, .d.ts.map, .js, .js.map per source file) with
  // the quality-findings-baseline/v1 schema.
  // The full-inventory regression requires requalification for any growth;
  // every other package retains the existing 2,500-entry bound.
  "@agent-teams/engineering-foundation": 2_780,
});

export function maximumArchiveEntries(packageName) {
  return typeof packageName === "string" && Object.hasOwn(PACKAGE_MAX_ARCHIVE_ENTRIES, packageName)
    ? PACKAGE_MAX_ARCHIVE_ENTRIES[packageName]
    : DEFAULT_MAX_ARCHIVE_ENTRIES;
}

function archiveEntries(listing, packageName) {
  const entries = listing.split(/\r?\n/u).filter(Boolean);
  if (entries.length > maximumArchiveEntries(packageName)) {
    throw new Error(`Package contains too many entries: ${entries.length}.`);
  }
  const identities = new Map();
  for (const entry of entries) {
    const identity = portableEntryIdentity(entry);
    const previous = identities.get(identity);
    if (previous !== undefined) {
      throw new Error(`Package contains duplicate or normalized-colliding archive members: ${previous}, ${entry}`);
    }
    identities.set(identity, entry);
  }
  return entries;
}

export function assertArchiveListing(
  listing,
  requiredArtifactPaths,
  allowedArtifactPaths = requiredArtifactPaths,
  packageName,
) {
  for (const forbidden of forbiddenEntries) {
    if (listing.includes(forbidden)) {
      throw new Error(`Forbidden package entry detected: ${forbidden}`);
    }
  }
  const entries = archiveEntries(listing, packageName);
  const entrySet = new Set(entries);
  const requiredEntries = [
    "package/package.json", "package/LICENSE", "package/README.md",
    ...requiredArtifactPaths.map((path) => `package/${path}`),
  ];
  for (const required of requiredEntries) {
    if (!entrySet.has(required)) {
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
    const packagePath = entry.startsWith("package/") ? entry.slice("package/".length).replace(/\/$/u, "") : "";
    const manifestAllows = allowedArtifactPaths.some((allowed) =>
      packagePath === allowed || packagePath.startsWith(`${allowed.replace(/\/$/u, "")}/`));
    if (!requiredDirectories.has(entry) && !entry.startsWith("package/dist/") &&
        !requiredEntries.includes(entry) && !manifestAllows) {
      throw new Error(`Package entry is outside the release allowlist: ${entry}`);
    }
  }
}

export function inspectCompressedTarArchive(archiveBytes, packageName) {
  return archiveCodec().inspectCompressedTarArchive(archiveBytes, maximumArchiveEntries(packageName));
}

function sameFileState(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export async function readRegularArchive(path) {
  return readRegularArchiveWithSymlinkError(path);
}

async function readRegularArchiveWithSymlinkError(path, symlinkError) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error(symlinkError ?? `Package archive is not a bounded regular file: ${path}.`, { cause: error });
    }
    throw error;
  }
  try {
    const [opened, pathnameBefore] = await Promise.all([handle.stat(), lstat(path)]);
    if (pathnameBefore.isSymbolicLink()) {
      throw new Error(symlinkError ?? `Package archive is not a bounded regular file: ${path}.`);
    }
    if (!opened.isFile() || !pathnameBefore.isFile() || opened.size > MAX_ARCHIVE_BYTES) {
      throw new Error(`Package archive is not a bounded regular file: ${path}.`);
    }
    if (!sameFileState(opened, pathnameBefore)) {
      throw new Error(`Package archive changed before verification: ${path}.`);
    }
    const bytes = Buffer.alloc(opened.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const overflow = Buffer.alloc(1);
    const { bytesRead: overflowBytes } = await handle.read(overflow, 0, 1, bytes.length);
    const [after, pathnameAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (bytesRead !== bytes.length || overflowBytes !== 0 || !sameFileState(opened, after) ||
        !sameFileState(opened, pathnameAfter)) {
      throw new Error(`Package archive changed during verification: ${path}.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export async function readVerifiedArchive(path, expectedSha256) {
  const bytes = await readRegularArchiveWithSymlinkError(
    path,
    `Verified package archive was replaced by a symlink: ${path}.`,
  );
  if (sha256(bytes) !== expectedSha256) {
    throw new Error(`Verified package archive digest changed: ${path}.`);
  }
  return bytes;
}

export async function readQualifiedReleaseArtifact(artifact, packageInfo) {
  if (artifact === undefined || artifact.packageName !== packageInfo.name ||
      artifact.packageVersion !== packageInfo.version) {
    throw new Error(`Qualified archive identity differs from release state for ${packageInfo.name}.`);
  }
  const { archivePath, sha256: digest } = artifact;
  const bytes = await readVerifiedArchive(archivePath, digest);
  const inspection = inspectCompressedTarArchive(bytes, packageInfo.name);
  const manifests = inspection.entries.filter(entry => entry.name === "package/package.json" && entry.type === "0");
  if (manifests.length !== 1 || inspection.entries.some(entry => !["0", "5"].includes(entry.type))) {
    throw new Error("Qualified package archive has an unsafe manifest or special entry.");
  }
  const manifest = JSON.parse(manifests[0].data.toString("utf8"));
  if (manifest.name !== packageInfo.name || manifest.version !== packageInfo.version) {
    throw new Error(`Qualified manifest identity differs from release state for ${packageInfo.name}.`);
  }
  return { archivePath, sha256: digest, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, manifest };
}

export function assertNoSpecialTarEntries(verboseListing) {
  for (const line of verboseListing.split(/\r?\n/u).filter(Boolean)) {
    const type = line[0];
    if (type !== "-" && type !== "d") {
      throw new Error(`Package contains a prohibited special tar entry: ${line}`);
    }
  }
}

export function assertArchiveSafety({
  allowedArtifactPaths,
  archiveBytes,
  listing,
  packageName,
  requiredArtifactPaths,
  verboseListing,
}) {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Package archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`);
  }
  assertArchiveListing(listing, requiredArtifactPaths, allowedArtifactPaths, packageName);
  assertNoSpecialTarEntries(verboseListing);
}
