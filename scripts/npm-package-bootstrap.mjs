import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";

import { assertArchiveSafety } from "./pack-artifact-e2e.mjs";
import { verifiedProvenanceFromNpmAudit } from "./release-publish-ordered-runtime.mjs";
import {
  NPM_PACKAGE_BOOTSTRAP,
  PORTABLE_PATH,
  exactStringArray,
  fail,
  isRecord,
} from "./npm-package-bootstrap-catalog.mjs";
import {
  auditLivePackage,
  liveDependencyVersions,
  livePackageEvidence,
} from "./npm-package-bootstrap-registry.mjs";

export {
  NPM_PACKAGE_BOOTSTRAP,
  bootstrapPackageById,
  parseBootstrapCatalog,
} from "./npm-package-bootstrap-catalog.mjs";
export {
  auditLivePackage,
  liveDependencyVersions,
  livePackageEvidence,
} from "./npm-package-bootstrap-registry.mjs";

function parseTimestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) {
    fail(`${label} must be an exact UTC timestamp with whole seconds.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value.replace("Z", ".000Z")) {
    fail(`${label} is not a canonical UTC timestamp.`);
  }
  return timestamp;
}

export function assertOneDayGranularTokenWindow({ createdAt, expiresAt, now }) {
  const created = parseTimestamp(createdAt, "token created_at");
  const expires = parseTimestamp(expiresAt, "token expires_at");
  const current = parseTimestamp(now, "current time");
  if (created > current || expires <= current) {
    fail("the granular token must already be active and not expired.");
  }
  if (expires - created <= 0 || expires - created > 24 * 60 * 60 * 1_000) {
    fail("the granular token lifetime must be no more than one day.");
  }
  if (expires - current < 15 * 60 * 1_000) {
    fail("the granular token must have at least fifteen minutes remaining.");
  }
}

function allowedPackedPath(profile, path) {
  return profile.contentPolicy.exact.includes(path) ||
    profile.contentPolicy.prefixes.some((prefix) => path.startsWith(prefix) && path.length > prefix.length);
}

function packReportEntry(packReport) {
  const entries = Array.isArray(packReport) ? packReport : [packReport];
  if (entries.length !== 1 || !isRecord(entries[0])) {
    fail("pnpm pack must report exactly one archive.");
  }
  return entries[0];
}

function expectedArchiveBasename(profile) {
  return `${profile.name.replace(/^@/u, "").replace("/", "-")}-${profile.bootstrapVersion}.tgz`;
}

function packReportFiles({ archivePath, packReport, profile }) {
  const report = packReportEntry(packReport);
  if (
    report.name !== profile.name ||
    report.version !== profile.bootstrapVersion ||
    typeof report.filename !== "string" ||
    typeof archivePath !== "string" ||
    resolvePath(report.filename) !== report.filename ||
    resolvePath(archivePath) !== archivePath ||
    archivePath !== report.filename ||
    basename(report.filename) !== expectedArchiveBasename(profile)
  ) {
    fail("pnpm pack reported an unexpected package identity or archive path.");
  }
  const files = report.files?.map((entry) => entry?.path);
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    new Set(files).size !== files.length ||
    files.some((path) => typeof path !== "string" || !PORTABLE_PATH.test(path) || !allowedPackedPath(profile, path))
  ) {
    fail("tarball contents escape the closed package allowlist.");
  }
  return files;
}

function assertRequiredPackFiles(profile, files, tarEntries) {
  for (const required of profile.contentPolicy.required) {
    if (!files.includes(required)) {
      fail(`tarball is missing ${required}.`);
    }
  }
  exactStringArray(tarEntries, "tarball entries");
  if (tarEntries.toSorted().join("\0") !== files.map((path) => `package/${path}`).toSorted().join("\0")) {
    fail("tarball entries disagree with the pack report.");
  }
}

function assertPackedManifest(profile, packedManifest) {
  if (
    packedManifest?.name !== profile.name ||
    packedManifest.version !== profile.bootstrapVersion ||
    packedManifest.private === true ||
    packedManifest.publishConfig?.access !== "public" ||
    packedManifest.publishConfig?.provenance !== true ||
    packedManifest.publishConfig?.registry !== NPM_PACKAGE_BOOTSTRAP.registry
  ) {
    fail("packed manifest does not match the public bootstrap identity.");
  }
  const expectedDependencies = Object.fromEntries(
    profile.dependencies.map(({ name, version }) => [name, version]),
  );
  const packedDependencies = packedManifest.dependencies ?? {};
  const exactDependencies = isRecord(packedDependencies) &&
    JSON.stringify(Object.fromEntries(Object.entries(packedDependencies).toSorted())) ===
      JSON.stringify(Object.fromEntries(Object.entries(expectedDependencies).toSorted()));
  const extraRuntimeSections = [
    "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies",
  ].some((key) => packedManifest[key] !== undefined);
  if (!exactDependencies || extraRuntimeSections) {
    fail("packed manifest runtime dependencies differ from the exact reviewed dependency map.");
  }
}

export function validatePackEvidence({
  archivePath,
  archiveBytes,
  packageTree,
  packedManifest,
  packReport,
  profile,
  tarEntries,
  tarVerboseListing,
}) {
  if (profile.state !== "approved" || profile.approval === null) {
    fail(`${profile.name} bootstrap is not approved.`);
  }
  const files = packReportFiles({ archivePath, packReport, profile });
  assertRequiredPackFiles(profile, files, tarEntries);
  try {
    assertArchiveSafety({
      allowedArtifactPaths: [
        ...profile.contentPolicy.exact,
        ...profile.contentPolicy.prefixes,
      ],
      archiveBytes,
      listing: `${tarEntries.join("\n")}\n`,
      requiredArtifactPaths: profile.contentPolicy.required,
      verboseListing: tarVerboseListing,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : "tarball contains a prohibited special entry.");
  }
  assertPackedManifest(profile, packedManifest);
  if (packageTree !== profile.approval.packageTree) {
    fail("package tree differs from reviewed bootstrap authority.");
  }
  const integrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
  if (integrity !== profile.approval.archiveIntegrity) {
    fail("packed archive differs from reviewed bootstrap integrity.");
  }
  return Object.freeze({ archivePath, integrity });
}

function normalizedVersions(metadata) {
  if (metadata === null) {
    return null;
  }
  const versions = Array.isArray(metadata?.versions) ? metadata.versions : [metadata?.versions];
  exactStringArray(versions, "registry versions");
  return versions;
}

function assertBootstrapTags(profile, tags) {
  if (!isRecord(tags)) {
    fail("registry dist-tags must be an object.");
  }
  if (Object.entries(tags).some(([tag, version]) =>
    !profile.tags.allowed.includes(tag) || version !== profile.bootstrapVersion)) {
    fail("registry contains an unexpected bootstrap dist-tag.");
  }
  if (profile.tags.required.some((tag) => tags[tag] !== profile.bootstrapVersion)) {
    fail("registry required bootstrap dist-tags are incomplete.");
  }
}

export function classifyRegistryPreflight({
  dependencyVersions,
  localIntegrity,
  packageMetadata,
  profile,
  publishedIntegrity,
}) {
  if (profile.state !== "approved" || profile.approval === null) {
    fail(`${profile.name} bootstrap is not approved.`);
  }
  for (const dependency of profile.dependencies) {
    if (dependencyVersions?.[dependency.name] !== dependency.version) {
      fail(`${dependency.name}@${dependency.version} is not available from npm.`);
    }
  }
  if (localIntegrity !== profile.approval.archiveIntegrity) {
    fail("local bootstrap integrity is not the reviewed integrity.");
  }
  if (packageMetadata === null) {
    if (publishedIntegrity !== null) {
      fail("absent package returned version integrity.");
    }
    return "publish";
  }
  const versions = normalizedVersions(packageMetadata);
  if (versions.length !== 1 || versions[0] !== profile.bootstrapVersion) {
    fail("existing package namespace is not the isolated bootstrap baseline.");
  }
  assertBootstrapTags(profile, packageMetadata["dist-tags"]);
  if (publishedIntegrity !== localIntegrity) {
    fail("existing bootstrap version is not the reviewed tarball.");
  }
  return "reuse";
}

export function assertProvenanceBinding({ auditEvidence, expectedCommit, profile }) {
  let provenance;
  try {
    provenance = verifiedProvenanceFromNpmAudit(
      auditEvidence,
      {
        integrity: profile.approval.archiveIntegrity,
        name: profile.name,
        version: profile.bootstrapVersion,
      },
      {
        ref: profile.provenance.ref,
        repository: NPM_PACKAGE_BOOTSTRAP.repository,
        workflow: profile.provenance.workflowPath,
      },
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : "npm provenance verification failed.");
  }
  if (expectedCommit !== undefined && provenance.commit !== expectedCommit) {
    fail("SLSA provenance is not bound to the expected reviewed commit.");
  }
  return provenance.commit;
}

export function assertBootstrapPostconditions({
  auditEvidence,
  deprecatedMessage,
  expectedCommit,
  localIntegrity,
  packageMetadata,
  profile,
  publishedIntegrity,
}) {
  assertBootstrapMutationPreconditions({
    auditEvidence,
    expectedCommit,
    localIntegrity,
    packageMetadata,
    profile,
    publishedIntegrity,
  });
  if (deprecatedMessage !== profile.deprecationMessage) {
    fail("bootstrap version does not carry the exact deprecation message.");
  }
}

export function assertBootstrapMutationPreconditions({
  auditEvidence,
  expectedCommit,
  localIntegrity,
  packageMetadata,
  profile,
  publishedIntegrity,
}) {
  assertPublishedBootstrapArtifact({
    auditEvidence,
    expectedCommit,
    localIntegrity,
    packageMetadata,
    profile,
    publishedIntegrity,
  });
}

export function assertPublishedBootstrapArtifact({
  auditEvidence,
  expectedCommit,
  localIntegrity,
  packageMetadata,
  profile,
  publishedIntegrity,
}) {
  const versions = normalizedVersions(packageMetadata);
  if (versions === null || versions.length !== 1 || versions[0] !== profile.bootstrapVersion) {
    fail("registry does not contain exactly the bootstrap version.");
  }
  assertBootstrapTags(profile, packageMetadata["dist-tags"]);
  if (localIntegrity !== profile.approval.archiveIntegrity || publishedIntegrity !== localIntegrity) {
    fail("published bootstrap integrity differs from the reviewed tarball.");
  }
  assertProvenanceBinding({ auditEvidence, expectedCommit, profile });
}

export function assertReusableBootstrap({
  auditEvidence,
  expectedCommit,
  localIntegrity,
  packageMetadata,
  profile,
  publishedIntegrity,
}) {
  assertPublishedBootstrapArtifact({
    auditEvidence,
    expectedCommit,
    localIntegrity,
    packageMetadata,
    profile,
    publishedIntegrity,
  });
}

export function assertBootstrapQuarantineCandidate({
  localIntegrity,
  packageMetadata,
  profile,
  publishedIntegrity,
}) {
  const versions = normalizedVersions(packageMetadata);
  if (versions.length !== 1 || versions[0] !== profile.bootstrapVersion) {
    fail("quarantine target is not the isolated bootstrap version.");
  }
  assertBootstrapTags(profile, packageMetadata["dist-tags"]);
  if (localIntegrity !== profile.approval.archiveIntegrity || publishedIntegrity !== localIntegrity) {
    fail("quarantine target differs from the exact reviewed tarball.");
  }
}

export function assertBootstrapQuarantinePostconditions(input) {
  assertBootstrapQuarantineCandidate(input);
  if (input.deprecatedMessage !== input.profile.deprecationMessage) {
    fail("quarantined bootstrap does not carry the exact deprecation message.");
  }
}

export function assertPublishedBootstrapBaseline({
  auditEvidence,
  deprecatedMessage,
  packageMetadata,
  profile,
  publishedIntegrity,
}) {
  if (!normalizedVersions(packageMetadata).includes(profile.bootstrapVersion)) {
    fail(`${profile.name}@${profile.bootstrapVersion} baseline is missing.`);
  }
  if (packageMetadata["dist-tags"]?.bootstrap !== profile.bootstrapVersion) {
    fail(`${profile.name} bootstrap tag does not resolve to its baseline.`);
  }
  if (publishedIntegrity !== profile.approval.archiveIntegrity || deprecatedMessage !== profile.deprecationMessage) {
    fail(`${profile.name} baseline does not match reviewed immutable evidence.`);
  }
  assertProvenanceBinding({ auditEvidence, profile });
}

export async function observeRegistryPreflight(
  profile,
  localIntegrity,
  { fetchImplementation = fetch, observationOptions } = {},
) {
  const live = await livePackageEvidence(profile, fetchImplementation, {
    ...observationOptions,
    retryNotFound: true,
  });
  return classifyRegistryPreflight({
    dependencyVersions: await liveDependencyVersions(
      profile,
      fetchImplementation,
      observationOptions,
    ),
    localIntegrity,
    packageMetadata: live?.metadata ?? null,
    profile,
    publishedIntegrity: live?.integrity ?? null,
  });
}

export async function verifyLiveBootstrapBaselines({
  auditPackage = auditLivePackage,
  catalog = NPM_PACKAGE_BOOTSTRAP,
  fetchImplementation = fetch,
  observationOptions,
  readManifest = async (path) => JSON.parse(await readFile(path, "utf8")),
  requireAllBaselines = false,
  temporaryRoot,
} = {}) {
  const verified = [];
  for (const profile of catalog.packages) {
    const manifest = await readManifest(resolvePath(profile.manifestPath));
    if (manifest?.name !== profile.name || typeof manifest.version !== "string") {
      fail(`${profile.manifestPath} does not match bootstrap catalog identity.`);
    }
    if (manifest.version === profile.bootstrapVersion && !requireAllBaselines) {
      continue;
    }
    if (profile.state === "candidate" || profile.approval === null) {
      fail(`${profile.name} cannot advance beyond ${profile.bootstrapVersion} before reviewed bootstrap approval.`);
    }
    const observation = {
      ...observationOptions,
      retryNotFound: true,
    };
    const initialEvidence = await livePackageEvidence(profile, fetchImplementation, observation);
    if (initialEvidence === null) {
      fail(`${profile.name}@${profile.bootstrapVersion} baseline is absent from npm.`);
    }
    const auditEvidence = await auditPackage(profile, temporaryRoot);
    const evidence = await livePackageEvidence(profile, fetchImplementation, observation);
    if (evidence === null) {
      fail(`${profile.name}@${profile.bootstrapVersion} baseline became absent during verification.`);
    }
    assertPublishedBootstrapBaseline({
      auditEvidence,
      deprecatedMessage: evidence.deprecatedMessage,
      packageMetadata: evidence.metadata,
      profile,
      publishedIntegrity: evidence.integrity,
    });
    verified.push(`${profile.name}@${profile.bootstrapVersion}`);
  }
  return Object.freeze(verified);
}

export async function verifyReleaseBootstrapBaselines(options = {}) {
  return verifyLiveBootstrapBaselines({ ...options, requireAllBaselines: true });
}

export function assertBootstrapReleasePolicy(state, registryState, catalog = NPM_PACKAGE_BOOTSTRAP) {
  const manifests = [...state.packages.private, ...state.packages.public]
    .map((entry) => JSON.parse(entry.manifestBytes));
  for (const profile of catalog.packages) {
    const manifest = manifests.find((entry) => entry.name === profile.name);
    if (manifest === undefined) {
      continue;
    }
    if (profile.state === "candidate" || profile.approval === null) {
      fail(`${profile.name} release requires reviewed bootstrap approval.`);
    }
    const registry = registryState.find((entry) => entry.name === profile.name);
    if (!registry?.versions.includes(profile.bootstrapVersion)) {
      fail(`${profile.name} release requires its immutable ${profile.bootstrapVersion} npm baseline.`);
    }
  }
}
