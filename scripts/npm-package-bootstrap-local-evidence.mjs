import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  NPM_PACKAGE_BOOTSTRAP,
  validatePackEvidence,
} from "./npm-package-bootstrap.mjs";
import { preparePackages } from "./prepare-package.mjs";

const execute = promisify(execFile);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

async function command(file, args) {
  const result = await execute(file, args, {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return result.stdout;
}

async function verifyProfile(profile) {
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
    return validatePackEvidence({
      archiveBytes: await readFile(archivePath),
      archivePath,
      packedManifest: JSON.parse(packedManifest),
      packageTree: packageTree.trim(),
      packReport,
      profile,
      tarEntries: tarEntries.trim().split("\n"),
      tarVerboseListing,
    });
  } finally {
    await rm(evidenceRoot, { force: true, recursive: true });
  }
}

async function main() {
  await preparePackages();
  const verified = [];
  for (const profile of NPM_PACKAGE_BOOTSTRAP.packages) {
    if (profile.state !== "approved") {
      continue;
    }
    const manifest = JSON.parse(await readFile(profile.manifestPath, "utf8"));
    if (manifest.version !== profile.bootstrapVersion) {
      continue;
    }
    const evidence = await verifyProfile(profile);
    verified.push(`${profile.name}@${profile.bootstrapVersion} ${evidence.integrity}`);
  }
  process.stdout.write(`Verified local npm bootstrap approvals: ${verified.join(", ") || "none pending"}.\n`);
}

await main();
