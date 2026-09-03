import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { NPM_PACKAGE_BOOTSTRAP } from "./npm-package-bootstrap-catalog.mjs";
import { packPublishableArtifacts } from "./pack-publishable-artifacts.mjs";
import {
  assertArchiveSafety,
  inspectCompressedTarArchive,
} from "./pack-artifact-e2e.mjs";
import { readRegularArchive } from "./pack-artifact-archive.mjs";
import { canonicalDigest } from "./pack-test-support.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_USAGE = "Usage: node scripts/npm-package-bootstrap-candidate-evidence.mjs --output <absolute-empty-directory>";

function fail(message) {
  throw new Error(`npm package bootstrap candidate evidence refused: ${message}`);
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha512(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function parseOutput(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--output" || !isAbsolute(arguments_[1])) {
    fail(OUTPUT_USAGE);
  }
  return resolve(arguments_[1]);
}

async function ensureEmptyOutput(outputRoot) {
  try {
    const entries = await readdir(outputRoot);
    if (entries.length !== 0) {
      fail("output directory must be empty so evidence cannot be overwritten.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    await mkdir(outputRoot, { recursive: true });
  }
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  const canonicalOutputRoot = await realpath(outputRoot);
  const outputRelative = relative(canonicalRepositoryRoot, canonicalOutputRoot);
  if (outputRelative === "" || (!outputRelative.startsWith("..") && !isAbsolute(outputRelative))) {
    fail("output directory must not be inside the repository.");
  }
}

async function git(args) {
  const result = await execute("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  return result.stdout.trim();
}

function candidateProfiles() {
  return NPM_PACKAGE_BOOTSTRAP.packages.filter(({ state }) => state === "candidate");
}

function archiveListing(entries) {
  return entries.map(({ name, size, type }) => ({
    name,
    size,
    type,
  }));
}

function verboseListing(entries) {
  return entries.map(({ name, size, type }) =>
    `${type === "5" ? "d" : "-"} ${size} ${name}`,
  ).join("\n");
}

function packageManifest(entries, profile) {
  const entry = entries.find(({ name }) => name === "package/package.json" && typeIsFile(entries, name));
  if (entry === undefined) {
    fail(`${profile.name} archive has no regular package/package.json entry.`);
  }
  try {
    return JSON.parse(entry.data.toString("utf8"));
  } catch (error) {
    fail(`${profile.name} archive manifest is invalid JSON: ${error.message}`);
  }
}

function typeIsFile(entries, name) {
  return entries.find((entry) => entry.name === name)?.type === "0";
}

async function inspectCandidate({ artifact, outputRoot, profile, sourceCommit }) {
  const archiveBytes = await readRegularArchive(artifact.archivePath);
  const inspection = inspectCompressedTarArchive(archiveBytes);
  const listing = archiveListing(inspection.entries);
  const listingText = inspection.entries.map(({ name }) => name).join("\n");
  const verboseText = verboseListing(inspection.entries);
  try {
    assertArchiveSafety({
      allowedArtifactPaths: [...profile.contentPolicy.exact, ...profile.contentPolicy.prefixes],
      archiveBytes,
      listing: `${listingText}\n`,
      requiredArtifactPaths: profile.contentPolicy.required,
      verboseListing: verboseText,
    });
  } catch (error) {
    fail(`${profile.name} archive failed candidate content policy: ${error.message}`);
  }
  const manifest = packageManifest(inspection.entries, profile);
  if (manifest.name !== profile.name || manifest.version !== profile.bootstrapVersion) {
    fail(`${profile.name} archive identity does not match the candidate catalog.`);
  }
  const packageDir = join(outputRoot, profile.id);
  await mkdir(packageDir);
  const archivePath = join(packageDir, artifact.archiveName);
  const listingPath = join(packageDir, "tar-listing.json");
  const manifestPath = join(packageDir, "package.json");
  const verboseListingPath = join(packageDir, "tar-verbose-listing.txt");
  await Promise.all([
    writeFile(archivePath, archiveBytes, { flag: "wx", mode: 0o444 }),
    writeFile(listingPath, `${JSON.stringify(listing, null, 2)}\n`, { flag: "wx", mode: 0o444 }),
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o444 }),
    writeFile(verboseListingPath, `${verboseText}\n`, { flag: "wx", mode: 0o444 }),
  ]);
  return Object.freeze({
    archive: `${profile.id}/${artifact.archiveName}`,
    archiveIntegrity: sha512(archiveBytes),
    archiveSha256: sha256(archiveBytes),
    id: profile.id,
    listing: `${profile.id}/tar-listing.json`,
    manifest: `${profile.id}/package.json`,
    manifestDigest: sha256(Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8")),
    name: profile.name,
    packageTree: await git(["rev-parse", `HEAD:${profile.root}`]),
    sourceCommit,
    version: profile.bootstrapVersion,
    verboseListing: `${profile.id}/tar-verbose-listing.txt`,
  });
}

export async function createCandidateEvidence({ outputRoot }) {
  if (typeof outputRoot !== "string" || !isAbsolute(outputRoot)) {
    fail("outputRoot must be an absolute path.");
  }
  await ensureEmptyOutput(outputRoot);
  const sourceCommit = await git(["rev-parse", "HEAD"]);
  const dirty = await git(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty !== "") {
    fail("repository worktree must be clean.");
  }
  const stagingRoot = join(outputRoot, ".staging");
  await mkdir(stagingRoot);
  try {
    const artifacts = await packPublishableArtifacts({ temporaryRoot: stagingRoot });
    const candidates = candidateProfiles();
    const records = [];
    for (const profile of candidates) {
      const artifact = artifacts[profile.name];
      if (artifact === undefined) {
        fail(`candidate ${profile.name} has no packed artifact.`);
      }
      records.push(await inspectCandidate({ artifact, outputRoot, profile, sourceCommit }));
    }
    const body = {
      schemaVersion: 1,
      kind: "npm-package-bootstrap-candidate-evidence",
      generatedAt: new Date().toISOString(),
      repository: NPM_PACKAGE_BOOTSTRAP.repository,
      sourceCommit,
      packages: records,
    };
    const receipt = {
      ...body,
      receiptDigest: canonicalDigest(body),
    };
    await writeFile(join(outputRoot, "candidate-evidence.receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o444,
    });
    return receipt;
  } finally {
    await rm(stagingRoot, { force: true, recursive: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputRoot = parseOutput(process.argv.slice(2));
  const receipt = await createCandidateEvidence({ outputRoot });
  process.stdout.write(
    `Prepared ${receipt.packages.length} candidate bootstrap evidence records at ${outputRoot}; receipt ${receipt.receiptDigest}.\n`,
  );
}
