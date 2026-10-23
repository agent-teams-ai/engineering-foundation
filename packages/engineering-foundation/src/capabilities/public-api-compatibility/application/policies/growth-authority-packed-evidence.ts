import type { GrowthAuthorityPackedEvidence } from "../model/growth-authority.js";

import type { GrowthDigest } from "../model/growth-observation.js";

import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import { hashGrowthPayload } from "./compare-growth-surfaces.js";
import {
  growthCanonicalJson,
  growthObservationReference,
  normalizeGrowthObservation,
} from "./normalize-growth-observation.js";
import {
  array,
  custodyPath,
  digest,
  exact,
  exactVersion,
  integrity,
  invalid,
  member,
  object,
  source,
  text,
  uniqueMap,
} from "./validate-growth-authority-primitives.js";

export function custodyDigest(
  evidence: GrowthAuthorityPackedEvidence["custodyEvidence"],
  fingerprint: ChangeFingerprint,
): GrowthDigest {
  return hashGrowthPayload(
    { domain: "foundation:sdk-growth:custody:1", payload: evidence },
    fingerprint,
  );
}

/** One archive representation: canonical JSON containing sorted paths and lowercase
 * hexadecimal file bytes. Transport compression is deliberately outside this identity. */
export function validateCustodyEvidence(
  value: unknown,
  fingerprint: ChangeFingerprint,
): GrowthAuthorityPackedEvidence["custodyEvidence"] {
  const row = object(value, [
    "archiveDigest",
    "archiveIntegrity",
    "archivePayload",
    "archiveManifest",
    "installedFiles",
  ]);
  const payload = row["archivePayload"];
  if (typeof payload !== "string" || payload.length > 64 * 1024 * 1024) {
    invalid("growth-authority-custody-payload-invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    invalid("growth-authority-custody-payload-invalid");
  }
  const archive = object(parsed, ["schemaVersion", "files"]);
  if (archive["schemaVersion"] !== "foundation:sdk-growth:archive:1") {
    invalid("growth-authority-custody-payload-invalid");
  }
  const paths = new Set<string>();
  const files = array(archive["files"], 100_000, "growth-authority-custody-invalid")
    .map((fileValue) => {
      const file = object(fileValue, ["path", "contentHex"]),
        name = custodyPath(file["path"]),
        contentHex = file["contentHex"];
      if (typeof contentHex !== "string" || !/^(?:[a-f0-9]{2})*$/u.test(contentHex)) {
        invalid("growth-authority-custody-payload-invalid");
      }
      const identity = name.toLowerCase();
      if (paths.has(identity)) {
        invalid("growth-authority-custody-duplicate-path");
      }
      paths.add(identity);
      return { path: name, contentHex };
    })
    .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  // Equality and hierarchy both use the same case-folded path identities.
  for (const identity of paths) {
    const parts = identity.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (paths.has(parts.slice(0, index).join("/"))) {
        invalid("growth-authority-path-invalid");
      }
    }
  }
  if (
    payload !== growthCanonicalJson({ schemaVersion: "foundation:sdk-growth:archive:1", files })
  ) {
    invalid("growth-authority-custody-payload-invalid");
  }
  const archiveDigest = `sha256:${fingerprint.sha256(payload)}`;
  if (fingerprint.sha512Integrity === undefined) {
    invalid("growth-authority-custody-integrity-unavailable");
  }
  const archiveIntegrity = fingerprint.sha512Integrity(payload);
  if (archiveDigest !== digest(row["archiveDigest"])) {
    invalid("growth-authority-archive-digest-mismatch");
  }
  if (archiveIntegrity !== integrity(row["archiveIntegrity"])) {
    invalid("growth-authority-archive-integrity-mismatch");
  }
  const archiveManifest: GrowthAuthorityPackedEvidence["custodyEvidence"]["archiveManifest"] =
    files.map((file) => ({
      path: file.path,
      digest: `sha256:${fingerprint.sha256(Uint8Array.from(file.contentHex.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16)))}`,
    }));
  for (const field of ["archiveManifest", "installedFiles"]) {
    const inventory = array(row[field], 100_000, "growth-authority-custody-invalid").map(
      (fileValue) => {
        const file = object(fileValue, ["path", "digest"]);
        return { path: custodyPath(file["path"]), digest: digest(file["digest"]) };
      },
    );
    uniqueMap(
      inventory,
      (file) => file.path.toLowerCase(),
      "growth-authority-custody-duplicate-path",
    );
    exact(inventory, archiveManifest, "growth-authority-custody-manifest-mismatch");
  }
  return {
    archiveDigest,
    archiveIntegrity,
    archivePayload: payload,
    archiveManifest,
    installedFiles: archiveManifest,
  };
}

/** Package coordinates are read from the canonical archive, never inferred from
 * transport labels or a producer's manifest. Retained observations are not packages. */
function validateArchivePackage(
  custody: GrowthAuthorityPackedEvidence["custodyEvidence"],
  packageName: string,
  packageVersion: string,
): void {
  const archive = JSON.parse(custody.archivePayload) as {
    files: { path: string; contentHex: string }[];
  };
  const manifest = archive.files.find((file) => file.path === "package.json");
  if (manifest === undefined) {
    invalid("growth-authority-archive-package-missing");
  }
  let metadata: unknown;
  try {
    const bytes = Uint8Array.from(manifest.contentHex.match(/../gu) ?? [], (byte) =>
      Number.parseInt(byte, 16),
    );
    metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    invalid("growth-authority-archive-package-invalid");
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    member(metadata, "name") !== packageName ||
    member(metadata, "version") !== packageVersion
  ) {
    invalid("growth-authority-archive-package-mismatch");
  }
}

export function validatePackedEvidence(
  value: unknown,
  repositoryIdentity: string,
  fingerprint: ChangeFingerprint,
): GrowthAuthorityPackedEvidence {
  const row = object(value, [
    "packageName",
    "packageVersion",
    "source",
    "archiveDigest",
    "archiveIntegrity",
    "observation",
    "observationDigest",
    "coverage",
    "custodyEvidence",
    "custodyEvidenceDigest",
    "installedDistribution",
  ]);
  const packageName = text(row["packageName"]),
    packageVersion = exactVersion(row["packageVersion"]);
  const archiveSource = source(row["source"]),
    archiveDigest = digest(row["archiveDigest"]);
  const archiveIntegrity = integrity(row["archiveIntegrity"]);
  const observation = normalizeGrowthObservation(
    row["observation"] as GrowthAuthorityPackedEvidence["observation"],
  );
  if (observation.repository !== repositoryIdentity) {
    invalid("growth-authority-packed-repository-mismatch");
  }
  exact(
    archiveSource,
    { commit: observation.sourceCommit, tree: observation.sourceTree },
    "growth-authority-archive-source-mismatch",
  );
  if (
    observation.coverage.length !== 1 ||
    observation.coverage[0]?.packageName !== packageName ||
    observation.entries.some((entry) => entry.coordinate.packageName !== packageName)
  ) {
    invalid("growth-authority-packed-scope-mismatch");
  }
  const observationDigest = digest(row["observationDigest"]);
  if (observationDigest !== growthObservationReference(observation, fingerprint).surfaceDigest) {
    invalid("growth-authority-packed-observation-mismatch");
  }
  exact(row["coverage"], observation.coverage[0], "growth-authority-packed-coverage-mismatch");
  const installed = object(row["installedDistribution"], [
    "packageName",
    "packageVersion",
    "source",
    "archiveDigest",
    "archiveIntegrity",
    "observationDigest",
  ]);
  const installedDistribution = {
    packageName: text(installed["packageName"]),
    packageVersion: exactVersion(installed["packageVersion"]),
    source: source(installed["source"]),
    archiveDigest: digest(installed["archiveDigest"]),
    archiveIntegrity: integrity(installed["archiveIntegrity"]),
    observationDigest: digest(installed["observationDigest"]),
  };
  exact(
    installedDistribution,
    {
      packageName,
      packageVersion,
      source: archiveSource,
      archiveDigest,
      archiveIntegrity,
      observationDigest,
    },
    "growth-authority-installed-distribution-mismatch",
  );
  const custodyEvidence = validateCustodyEvidence(row["custodyEvidence"], fingerprint);
  validateArchivePackage(custodyEvidence, packageName, packageVersion);
  exact(
    { archiveDigest, archiveIntegrity },
    {
      archiveDigest: custodyEvidence.archiveDigest,
      archiveIntegrity: custodyEvidence.archiveIntegrity,
    },
    "growth-authority-custody-inventory-mismatch",
  );
  const custodyEvidenceDigest = custodyDigest(custodyEvidence, fingerprint);
  if (custodyEvidenceDigest !== digest(row["custodyEvidenceDigest"])) {
    invalid("growth-authority-custody-digest-mismatch");
  }
  return {
    packageName,
    packageVersion,
    source: archiveSource,
    archiveDigest,
    archiveIntegrity,
    observation,
    observationDigest,
    coverage: observation.coverage[0],
    custodyEvidenceDigest,
    custodyEvidence,
    installedDistribution,
  };
}
