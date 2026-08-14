import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export const DOCS_PROTOCOL_BOOTSTRAP = Object.freeze({
  deprecationMessage:
    "Bootstrap-only artifact; do not adopt. Use a supported @agent-teams/docs-protocol release candidate instead.",
  foundationName: "@agent-teams/engineering-foundation",
  foundationVersion: "0.17.0-rc.0",
  name: "@agent-teams/docs-protocol",
  registry: "https://registry.npmjs.org/",
  tags: Object.freeze(["bootstrap", "latest"]),
  version: "0.0.0",
});

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message) {
  throw new Error(`Docs Protocol bootstrap refused: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object.`);
  }
  const actual = Object.keys(value).toSorted();
  if (actual.join("\0") !== [...expected].toSorted().join("\0")) {
    fail(`${label} keys must be exactly ${expected.join(", ")}.`);
  }
}

function exactStringArray(value, expected, label) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string") ||
    value.toSorted().join("\0") !== [...expected].toSorted().join("\0")
  ) {
    fail(`${label} must be exactly ${expected.join(", ")}.`);
  }
}

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

export function assertOrdinaryReleaseBootstrapState({
  changesetsConfig,
  docsManifest,
  publishablePackageNames,
}) {
  if (
    docsManifest?.name !== DOCS_PROTOCOL_BOOTSTRAP.name ||
    docsManifest.version !== DOCS_PROTOCOL_BOOTSTRAP.version ||
    docsManifest.private !== true
  ) {
    fail("ordinary release requires Docs Protocol to remain private at exact version 0.0.0.");
  }
  if (
    !Array.isArray(changesetsConfig?.ignore) ||
    !changesetsConfig.ignore.includes(DOCS_PROTOCOL_BOOTSTRAP.name)
  ) {
    fail("ordinary release requires Changesets to ignore Docs Protocol.");
  }
  if (publishablePackageNames.includes(DOCS_PROTOCOL_BOOTSTRAP.name)) {
    fail("ordinary release must not own Docs Protocol during bootstrap.");
  }
  if (Object.hasOwn(docsManifest, "publishConfig")) {
    fail("ordinary release bootstrap state must not contain Docs Protocol publishConfig.");
  }
}

export function assertBootstrapPromotionManifest({
  changesetsConfig,
  docsManifest,
  foundationManifest,
}) {
  if (
    docsManifest?.name !== DOCS_PROTOCOL_BOOTSTRAP.name ||
    docsManifest.version !== DOCS_PROTOCOL_BOOTSTRAP.version ||
    docsManifest.private === true
  ) {
    fail("bootstrap publication requires the reviewed public Docs Protocol 0.0.0 manifest.");
  }
  if (changesetsConfig?.ignore?.includes(DOCS_PROTOCOL_BOOTSTRAP.name)) {
    fail("bootstrap publication requires the reviewed removal of the Changesets ignore.");
  }
  if (
    docsManifest.dependencies?.[DOCS_PROTOCOL_BOOTSTRAP.foundationName] !== "workspace:*" ||
    foundationManifest?.name !== DOCS_PROTOCOL_BOOTSTRAP.foundationName ||
    foundationManifest.version !== DOCS_PROTOCOL_BOOTSTRAP.foundationVersion
  ) {
    fail("bootstrap publication requires workspace Foundation 0.17.0-rc.0.");
  }
  if (
    docsManifest.publishConfig?.access !== "public" ||
    docsManifest.publishConfig.provenance !== true ||
    docsManifest.publishConfig.registry !== DOCS_PROTOCOL_BOOTSTRAP.registry
  ) {
    fail("bootstrap publication requires exact public npm provenance configuration.");
  }
}

export function ordinaryReleaseDocsPolicy({
  changesetsConfig,
  docsManifest,
  foundationManifest,
  preState,
  publishablePackageNames,
  registryVersion,
}) {
  if (docsManifest?.private === true) {
    assertOrdinaryReleaseBootstrapState({
      changesetsConfig,
      docsManifest,
      publishablePackageNames,
    });
    return "private-stage";
  }
  assertBootstrapPromotionManifest({ changesetsConfig, docsManifest, foundationManifest });
  if (!publishablePackageNames.includes(DOCS_PROTOCOL_BOOTSTRAP.name)) {
    fail("public Docs Protocol must have exactly one ordinary publishable-package entry.");
  }
  if (preState?.mode === "pre" && registryVersion !== DOCS_PROTOCOL_BOOTSTRAP.version) {
    fail(
      "active prerelease publication requires the stable Docs Protocol 0.0.0 baseline to already exist on npm.",
    );
  }
  if (registryVersion !== DOCS_PROTOCOL_BOOTSTRAP.version) {
    fail("ordinary publication cannot create the Docs Protocol 0.0.0 bootstrap artifact.");
  }
  return "published-bootstrap";
}

function allowedPackedPath(path) {
  return (
    ["CHANGELOG.md", "LICENSE", "README.md", "package.json"].includes(path) ||
    path.startsWith("dist/") ||
    [
      "schemas/docs-protocol-command-envelope/v1.schema.json",
      "schemas/docs-protocol-profile/v1.schema.json",
      "schemas/docs-protocol/v1.schema.json",
    ].includes(path)
  );
}

function packReportEntry(packReport) {
  const entries = Array.isArray(packReport) ? packReport : [packReport];
  if (entries.length !== 1 || !isRecord(entries[0])) {
    fail("pnpm pack must report exactly one archive.");
  }
  return entries[0];
}

export function validatePackEvidence({ archiveBytes, packedManifest, packReport, tarEntries }) {
  const report = packReportEntry(packReport);
  if (
    report.name !== DOCS_PROTOCOL_BOOTSTRAP.name ||
    report.version !== DOCS_PROTOCOL_BOOTSTRAP.version ||
    typeof report.filename !== "string" ||
    resolve(report.filename) !== report.filename ||
    basename(report.filename) !== "agent-teams-docs-protocol-0.0.0.tgz"
  ) {
    fail("pnpm pack reported an unexpected package identity or archive path.");
  }
  const files = report.files?.map((entry) => entry?.path);
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    new Set(files).size !== files.length ||
    files.some(
      (path) =>
        typeof path !== "string" ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").includes("..") ||
        !allowedPackedPath(path),
    )
  ) {
    fail("tarball contents escape the closed Docs Protocol allowlist.");
  }
  for (const required of [
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "package.json",
    "schemas/docs-protocol-command-envelope/v1.schema.json",
    "schemas/docs-protocol-profile/v1.schema.json",
    "schemas/docs-protocol/v1.schema.json",
  ]) {
    if (!files.includes(required)) {
      fail(`tarball is missing ${required}.`);
    }
  }
  exactStringArray(tarEntries, files.map((path) => `package/${path}`), "tarball entries");
  if (
    packedManifest?.name !== DOCS_PROTOCOL_BOOTSTRAP.name ||
    packedManifest.version !== DOCS_PROTOCOL_BOOTSTRAP.version ||
    packedManifest.private === true ||
    packedManifest.dependencies?.[DOCS_PROTOCOL_BOOTSTRAP.foundationName] !==
      DOCS_PROTOCOL_BOOTSTRAP.foundationVersion
  ) {
    fail("packed manifest does not bind public Docs Protocol 0.0.0 to exact Foundation RC.");
  }
  const integrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
  return Object.freeze({
    archivePath: report.filename,
    integrity,
  });
}

function normalizedVersions(metadata) {
  if (metadata === null) {
    return null;
  }
  const versions = Array.isArray(metadata?.versions) ? metadata.versions : [metadata?.versions];
  exactStringArray(versions, [DOCS_PROTOCOL_BOOTSTRAP.version], "registry versions");
  return versions;
}

function assertNoUnexpectedTags(tags, requireBoth) {
  if (!isRecord(tags)) {
    fail("registry dist-tags must be an object.");
  }
  const expectedKeys = requireBoth ? DOCS_PROTOCOL_BOOTSTRAP.tags : Object.keys(tags);
  if (Object.keys(tags).some((tag) => !DOCS_PROTOCOL_BOOTSTRAP.tags.includes(tag))) {
    fail("registry contains an unexpected Docs Protocol dist-tag.");
  }
  if (requireBoth) {
    exactKeys(tags, expectedKeys, "registry dist-tags");
  }
  for (const value of Object.values(tags)) {
    if (value !== DOCS_PROTOCOL_BOOTSTRAP.version) {
      fail("registry dist-tags must resolve only to Docs Protocol 0.0.0.");
    }
  }
}

export function classifyRegistryPreflight({
  docsMetadata,
  foundationVersion,
  localIntegrity,
  publishedIntegrity,
}) {
  if (foundationVersion !== DOCS_PROTOCOL_BOOTSTRAP.foundationVersion) {
    fail("Foundation 0.17.0-rc.0 is not available from npm.");
  }
  if (docsMetadata === null) {
    if (publishedIntegrity !== null) {
      fail("absent Docs Protocol package returned version integrity.");
    }
    return "publish";
  }
  normalizedVersions(docsMetadata);
  assertNoUnexpectedTags(docsMetadata["dist-tags"], false);
  if (publishedIntegrity !== localIntegrity) {
    fail("existing Docs Protocol 0.0.0 is not the exact reviewed tarball.");
  }
  return "reuse";
}

export function assertBootstrapPostconditions({
  auditEvidence,
  deprecatedMessage,
  docsMetadata,
  localIntegrity,
  publishedIntegrity,
}) {
  normalizedVersions(docsMetadata);
  assertNoUnexpectedTags(docsMetadata["dist-tags"], true);
  if (publishedIntegrity !== localIntegrity) {
    fail("published Docs Protocol integrity differs from the reviewed tarball.");
  }
  if (deprecatedMessage !== DOCS_PROTOCOL_BOOTSTRAP.deprecationMessage) {
    fail("Docs Protocol 0.0.0 does not carry the exact bootstrap deprecation.");
  }
  if (
    !Array.isArray(auditEvidence?.invalid) ||
    auditEvidence.invalid.length !== 0 ||
    !Array.isArray(auditEvidence.missing) ||
    auditEvidence.missing.length !== 0 ||
    !Array.isArray(auditEvidence.verified)
  ) {
    fail("npm signature audit did not return clean verification evidence.");
  }
  const verified = auditEvidence.verified.filter(
    (entry) =>
      entry?.name === DOCS_PROTOCOL_BOOTSTRAP.name &&
      entry.version === DOCS_PROTOCOL_BOOTSTRAP.version,
  );
  if (
    verified.length !== 1 ||
    verified[0].attestations?.provenance?.predicateType !==
      "https://slsa.dev/provenance/v1" ||
    !Array.isArray(verified[0].attestationBundles) ||
    verified[0].attestationBundles.length === 0
  ) {
    fail("npm audit did not prove one SLSA provenance attestation and Sigstore bundle.");
  }
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function output(path, values) {
  await appendFile(
    path,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
    "utf8",
  );
}

async function cli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "ordinary-release-state") {
    const { PUBLISHABLE_PACKAGES } = await import("./publishable-packages.mjs");
    const changesetsConfig = await json(".changeset/config.json");
    const docsManifest = await json("packages/docs-protocol/package.json");
    const publishablePackageNames = PUBLISHABLE_PACKAGES.map((entry) => entry.name);
    if (docsManifest.private === true) {
      assertOrdinaryReleaseBootstrapState({
        changesetsConfig,
        docsManifest,
        publishablePackageNames,
      });
    } else {
      assertBootstrapPromotionManifest({
        changesetsConfig,
        docsManifest,
        foundationManifest: await json("packages/engineering-foundation/package.json"),
      });
      if (!publishablePackageNames.includes(DOCS_PROTOCOL_BOOTSTRAP.name)) {
        fail("public Docs Protocol must have exactly one ordinary publishable-package entry.");
      }
    }
    return;
  }
  if (command === "token-window") {
    assertOneDayGranularTokenWindow({ createdAt: args[0], expiresAt: args[1], now: args[2] });
    return;
  }
  if (command === "promotion-manifest") {
    assertBootstrapPromotionManifest({
      changesetsConfig: await json(args[0]),
      docsManifest: await json(args[1]),
      foundationManifest: await json(args[2]),
    });
    return;
  }
  if (command === "pack-evidence") {
    const evidence = validatePackEvidence({
      archiveBytes: await readFile(args[3]),
      packedManifest: await json(args[1]),
      packReport: await json(args[0]),
      tarEntries: (await readFile(args[2], "utf8")).trim().split("\n"),
    });
    await output(args[4], evidence);
    return;
  }
  if (command === "registry-preflight") {
    const action = classifyRegistryPreflight({
      docsMetadata: await json(args[1]),
      foundationVersion: await json(args[0]),
      localIntegrity: args[3],
      publishedIntegrity: await json(args[2]),
    });
    await output(args[4], { action });
    return;
  }
  if (command === "postconditions") {
    assertBootstrapPostconditions({
      auditEvidence: await json(args[3]),
      deprecatedMessage: await json(args[2]),
      docsMetadata: await json(args[0]),
      localIntegrity: args[4],
      publishedIntegrity: await json(args[1]),
    });
    return;
  }
  fail("unknown command.");
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  await cli();
}
