import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectCompressedTarArchive } from "./pack-artifact-archive.mjs";
import { livePackageEvidence } from "./npm-package-bootstrap-registry.mjs";
import { validatePackEvidence } from "./npm-package-bootstrap.mjs";
import { readRegistryBytes } from "./npm-registry-read.ts";

type RecoveryProfile = {
  name: string;
  bootstrapVersion: string;
  approval: { archiveIntegrity: string; packageTree: string } | null;
  recovery?: { sourceCommit: string; runId: number; runAttempt: number };
};

export function publishedBootstrapCommit(
  profile: RecoveryProfile,
  operatingCommit: string,
): string {
  if (!/^[a-f0-9]{40}$/u.test(operatingCommit)) {
    throw new Error("Invalid protected-main commit.");
  }
  return profile.recovery?.sourceCommit ?? operatingCommit;
}

export async function prepareExistingBootstrap(
  profile: RecoveryProfile,
  originalPackageTree: string,
  outputRoot: string,
  fetchImplementation: typeof fetch = fetch,
) {
  if (
    profile.recovery === undefined ||
    profile.approval === null ||
    originalPackageTree !== profile.approval.packageTree
  ) {
    throw new Error("Existing bootstrap requires the exact reviewed original source tree.");
  }
  const live = await livePackageEvidence(profile, fetchImplementation);
  if (
    live === null ||
    live.integrity !== profile.approval.archiveIntegrity ||
    live.metadata.versions.length !== 1 ||
    live.metadata.versions[0] !== profile.bootstrapVersion
  ) {
    throw new Error(
      "Existing-only bootstrap is absent or differs from reviewed authority; publication is forbidden.",
    );
  }
  const leaf = profile.name.split("/").at(-1);
  const url = `https://registry.npmjs.org/${profile.name}/-/${leaf}-${profile.bootstrapVersion}.tgz`;
  const response = await readRegistryBytes(url, fetchImplementation);
  if (
    response.status !== 200 ||
    `sha512-${createHash("sha512").update(response.bytes).digest("base64")}` !==
      profile.approval.archiveIntegrity
  ) {
    throw new Error(
      "Existing bootstrap archive is unavailable or differs from reviewed integrity.",
    );
  }
  const inspection = inspectCompressedTarArchive(response.bytes, profile.name);
  const entries = inspection.entries;
  const manifest = entries.find(
    (entry) => entry.name === "package/package.json" && entry.type === "0",
  );
  if (manifest === undefined || entries.some((entry) => entry.type !== "0")) {
    throw new Error("Reviewed existing bootstrap archive contains an unexpected member.");
  }
  const archivePath = resolve(
    outputRoot,
    `${profile.name.replace(/^@/u, "").replace("/", "-")}-${profile.bootstrapVersion}.tgz`,
  );
  const packedManifest: unknown = JSON.parse(manifest.data.toString("utf8"));
  validatePackEvidence({
    archivePath,
    archiveBytes: response.bytes,
    packageTree: originalPackageTree,
    packedManifest,
    packReport: {
      name: profile.name,
      version: profile.bootstrapVersion,
      filename: archivePath,
      files: entries.map((entry) => ({ path: entry.name.slice("package/".length) })),
    },
    profile,
    tarEntries: entries.map((entry) => entry.name),
    tarVerboseListing: entries.map((entry) => `- ${entry.size} ${entry.name}`).join("\n"),
  });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(archivePath, response.bytes, { flag: "wx" });
  await writeFile(
    resolve(outputRoot, "existing-artifact.json"),
    `${JSON.stringify(
      {
        mode: "existing-artifact-only",
        sourceCommit: profile.recovery.sourceCommit,
        runId: profile.recovery.runId,
        runAttempt: profile.recovery.runAttempt,
        packageTree: originalPackageTree,
        integrity: profile.approval.archiveIntegrity,
        live,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  return { archivePath, integrity: profile.approval.archiveIntegrity };
}
