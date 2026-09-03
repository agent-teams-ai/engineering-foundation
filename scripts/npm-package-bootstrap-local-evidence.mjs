import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  NPM_PACKAGE_BOOTSTRAP,
  validatePackEvidence,
} from "./npm-package-bootstrap.mjs";
import { preparePackages } from "./prepare-package.mjs";
import { canonicalDigest } from "./pack-test-support.mjs";

const execute = promisify(execFile);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

async function command(file, args) {
  const result = await execute(file, args, {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return result.stdout;
}

function archiveIntegrity(archiveBytes) {
  return `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
}

function archiveSha256(archiveBytes) {
  return `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`;
}

async function retainWriterEvidence({
  archiveBytes,
  archivePath,
  outputRoot,
  packedManifest,
  profile,
  packageTree,
  tarEntries,
  tarVerboseListing,
}) {
  if (outputRoot === null) {
    return null;
  }
  const packageRoot = join(outputRoot, profile.id);
  await mkdir(packageRoot, { recursive: true });
  const archiveName = basename(archivePath);
  await Promise.all([
    writeFile(join(packageRoot, archiveName), archiveBytes, { flag: "wx", mode: 0o444 }),
    writeFile(join(packageRoot, "package.json"), `${JSON.stringify(packedManifest, null, 2)}\n`, { flag: "wx", mode: 0o444 }),
    writeFile(join(packageRoot, "tar-listing.txt"), tarEntries, { flag: "wx", mode: 0o444 }),
    writeFile(join(packageRoot, "tar-verbose-listing.txt"), tarVerboseListing, { flag: "wx", mode: 0o444 }),
  ]);
  return Object.freeze({
    archive: `${profile.id}/${archiveName}`,
    archiveIntegrity: archiveIntegrity(archiveBytes),
    archiveSha256: archiveSha256(archiveBytes),
    id: profile.id,
    name: profile.name,
    packageTree,
    version: profile.bootstrapVersion,
  });
}

async function verifyProfile(profile, outputRoot) {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "npm-bootstrap-local-evidence-"));
  try {
    const packReport = JSON.parse(await command("pnpm", [
      "--filter",
      profile.name,
      "pack",
      "--pack-destination",
      evidenceRoot,
      "--json",
      "--config.ignore-scripts=true",
    ]));
    const report = Array.isArray(packReport) ? packReport[0] : packReport;
    const archivePath = report?.filename;
    if (typeof archivePath !== "string") {
      throw new Error(`${profile.name} pack report did not contain an archive path.`);
    }
    const [tarEntries, tarVerboseListing, packedManifest, packageTree] = await Promise.all([
      command("tar", ["-tzf", archivePath]),
      command("tar", ["-tvzf", archivePath]),
      command("tar", ["-xOf", archivePath, "package/package.json"]),
      command("git", ["rev-parse", `HEAD:${profile.root}`]),
    ]);
    const archiveBytes = await readFile(archivePath);
    const parsedManifest = JSON.parse(packedManifest);
    const packageTreeValue = packageTree.trim();
    const writerEvidence = await retainWriterEvidence({
      archiveBytes,
      archivePath,
      outputRoot,
      packedManifest: parsedManifest,
      profile,
      packageTree: packageTreeValue,
      tarEntries,
      tarVerboseListing,
    });
    try {
      const validated = validatePackEvidence({
        archiveBytes,
      archivePath,
      packedManifest: parsedManifest,
      packageTree: packageTreeValue,
      packReport,
      profile,
      tarEntries: tarEntries.trim().split("\n"),
      tarVerboseListing,
      });
      return Object.freeze({ ...validated, writerEvidence });
    } catch (error) {
      const observed = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
      const message = error instanceof Error ? error.message : "bootstrap writer evidence failed.";
      const wrapped = new Error(`${message} (observed ${observed})`, { cause: error });
      wrapped.writerEvidence = writerEvidence ?? Object.freeze({
        archive: basename(archivePath),
        archiveIntegrity: observed,
        archiveSha256: archiveSha256(archiveBytes),
        id: profile.id,
        name: profile.name,
        packageTree: packageTreeValue,
        version: profile.bootstrapVersion,
      });
      throw wrapped;
    }
  } finally {
    await rm(evidenceRoot, { force: true, recursive: true });
  }
}

async function main(outputRoot = null) {
  if (outputRoot !== null) {
    await mkdir(outputRoot, { recursive: true });
  }
  await preparePackages();
  const verified = [];
  const failures = [];
  const writerEvidence = [];
  const sourceCommit = await command("git", ["rev-parse", "HEAD"]);
  for (const profile of NPM_PACKAGE_BOOTSTRAP.packages) {
    if (profile.state !== "approved") {
      continue;
    }
    const manifest = JSON.parse(await readFile(profile.manifestPath, "utf8"));
    if (manifest.version !== profile.bootstrapVersion) {
      continue;
    }
    try {
      const evidence = await verifyProfile(profile, outputRoot);
      verified.push(`${profile.name}@${profile.bootstrapVersion} ${evidence.integrity}`);
      if (evidence.writerEvidence !== undefined) {
        writerEvidence.push(evidence.writerEvidence);
      }
    } catch (error) {
      if (error?.writerEvidence !== undefined) {
        writerEvidence.push(error.writerEvidence);
      }
      failures.push(`${profile.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (outputRoot !== null) {
    const body = {
      schemaVersion: 1,
      kind: "npm-package-bootstrap-writer-evidence",
      generatedAt: new Date().toISOString(),
      repository: NPM_PACKAGE_BOOTSTRAP.repository,
      sourceCommit: sourceCommit.trim(),
      packages: writerEvidence,
    };
    await writeFile(
      join(outputRoot, "writer-evidence.receipt.json"),
      `${JSON.stringify({ ...body, receiptDigest: canonicalDigest(body) }, null, 2)}\n`,
      { flag: "wx", mode: 0o444 },
    );
  }
  if (failures.length > 0) {
    throw new Error(`Bootstrap writer evidence failed for ${failures.length} package(s): ${failures.join("; ")}`);
  }
  process.stdout.write(`Verified local npm bootstrap approvals: ${verified.join(", ") || "none pending"}.\n`);
}

const outputArgument = process.argv.slice(2);
if (outputArgument.length === 0) {
  await main();
} else if (outputArgument.length === 2 && outputArgument[0] === "--output" && isAbsolute(outputArgument[1])) {
  await main(resolve(outputArgument[1]));
} else {
  throw new Error("Usage: node scripts/npm-package-bootstrap-local-evidence.mjs [--output <absolute-directory>]");
}
