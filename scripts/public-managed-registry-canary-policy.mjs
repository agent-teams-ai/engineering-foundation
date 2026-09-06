import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { Ajv2020 } from "ajv/dist/2020.js";

import { publishablePackageByName } from "./publishable-packages.mjs";
import { parseStableVersion } from "./release-publish-registry-version.mjs";

const SHA512_SRI = /^sha512-([A-Za-z0-9+/]+={0,2})$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^sha256:(?!0{64}$)[a-f0-9]{64}$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const COHORT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
export const CENTRAL_AUTHORITY = Object.freeze({
  path: "governance/docs-qualified-cohorts.json",
  repository: "agent-teams-ai/.github",
  schemaPath: "governance/docs-qualified-cohorts.schema.json",
});
// Changesets-owned release manifests select versions; central Cohort membership stays separate.
const supportingMcpRelease = publishablePackageByName("@agent-teams/docs-protocol-mcp");
const supportingMcpManifest = JSON.parse(readFileSync(
  new URL(`../${supportingMcpRelease.manifestPath}`, import.meta.url), "utf8",
));
if (supportingMcpManifest.name !== supportingMcpRelease.name ||
    parseStableVersion(supportingMcpManifest.version) === undefined) {
  throw new Error("Supporting MCP requires an exact stable release manifest coordinate.");
}
export const SUPPORTING_MCP_PACKAGE = Object.freeze({
  name: supportingMcpRelease.name,
  version: supportingMcpManifest.version,
});

async function fetchAuthorityJson(url, fetcher) {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) { throw new Error(`Central authority fetch failed with HTTP ${response.status}.`); }
  return await response.json();
}

async function defaultProjectAuthority(input) {
  const { projectDocsProtocolQualificationV3Authority } = await import(
    "../packages/docs-protocol-agent-teams/dist/qualification/index.js"
  );
  return projectDocsProtocolQualificationV3Authority(input);
}

export async function observeCentralCohortAuthority(
  { inputs, repository },
  { fetcher = globalThis.fetch, projectAuthority = defaultProjectAuthority } = {},
) {
  const branch = await fetchAuthorityJson(
    `https://api.github.com/repos/${CENTRAL_AUTHORITY.repository}/branches/main`, fetcher,
  );
  if (branch?.protected !== true || branch?.commit?.sha !== inputs.authorityRevision) {
    throw new Error("Central authority revision is not the current protected-main SHA.");
  }
  const rawRoot = `https://raw.githubusercontent.com/${CENTRAL_AUTHORITY.repository}/${inputs.authorityRevision}`;
  const [registry, schema] = await Promise.all([
    fetchAuthorityJson(`${rawRoot}/${CENTRAL_AUTHORITY.path}`, fetcher),
    fetchAuthorityJson(`${rawRoot}/${CENTRAL_AUTHORITY.schemaPath}`, fetcher),
  ]);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(registry)) {
    throw new Error(`Central Cohort registry schema validation failed: ${JSON.stringify(validate.errors)}`);
  }
  const projected = await projectAuthority({
    cohortId: inputs.cohortId, registry, repository, revision: inputs.authorityRevision,
  });
  return createCanaryAuthority(projected, inputs);
}
const COHORT_PACKAGES = Object.freeze([
  Object.freeze({ key: "repositoryMutation", name: "@agent-teams/repository-mutation", direct: false }),
  Object.freeze({ key: "documentAuthoring", name: "@agent-teams/document-authoring", direct: false }),
  Object.freeze({ key: "docsProtocol", name: "@agent-teams/docs-protocol", direct: true }),
  Object.freeze({ key: "docsProtocolAgentTeams", name: "@agent-teams/docs-protocol-agent-teams", direct: true }),
  Object.freeze({ key: "engineeringFoundation", name: "@agent-teams/engineering-foundation", direct: true }),
]);
const FORBIDDEN_PORTABLE_TERMS = [
  "docs-consumer-integration",
  "managed-state",
  "qualifieddocscohort",
  "rundocsprotocolqualificationv2",
  "rundocsprotocolqualificationv3",
];

function fail(message) {
  throw new Error(`Public managed registry canary policy rejected: ${message}`);
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (Object.keys(value).toSorted().join("\0") !== [...keys].toSorted().join("\0")) {
    fail(`${label} has unexpected keys`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).toSorted(([left], [right]) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalReceiptDigest(receiptWithoutDigest) {
  return `sha256:${createHash("sha256").update(canonicalJson(receiptWithoutDigest)).digest("hex")}`;
}

function canonicalIntegrity(value, label) {
  const match = SHA512_SRI.exec(value ?? "");
  const bytes = match === null ? undefined : Buffer.from(match[1], "base64");
  if (bytes?.length !== 64 || bytes.toString("base64") !== match[1]) {
    fail(`${label} must be a canonical sha512 SRI`);
  }
  return value;
}

function exactCohortIds(value, label) {
  if (!Array.isArray(value) || value.length > 32 || new Set(value).size !== value.length ||
      !value.every((entry) => typeof entry === "string" && COHORT_ID.test(entry))) {
    fail(`${label} must contain unique canonical Cohort IDs`);
  }
}

function canonicalUtcSeconds(value, label) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().replace(".000", "") !== value) {
    fail(`${label} must be a canonical UTC timestamp with second precision`);
  }
}

function validateCohortIdentity(cohort) {
  if (cohort.schemaVersion !== 2 || !COHORT_ID.test(cohort.cohortId ?? "") ||
      !["rc", "stable"].includes(cohort.channel) || !SHA256.test(cohort.recordDigest ?? "") ||
      !SHA256.test(cohort.qualificationEventDigest ?? "")) {
    fail("Cohort v2 identity or authority digests are invalid");
  }
  canonicalUtcSeconds(cohort.eligibleAfter, "eligibleAfter");
}

function validateCohortTransitions(cohort) {
  exactCohortIds(cohort.upgradeFrom, "upgradeFrom");
  exactCohortIds(cohort.rollbackTo, "rollbackTo");
  if (cohort.upgradeFrom.includes(cohort.cohortId) || cohort.rollbackTo.includes(cohort.cohortId) ||
      !cohort.rollbackTo.every((entry) => cohort.upgradeFrom.includes(entry))) {
    fail("Cohort transition authority is invalid");
  }
}

function cohortCoordinates(packages) {
  exactKeys(packages, COHORT_PACKAGES.map(({ key }) => key), "Cohort packages");
  return COHORT_PACKAGES.map(({ key, name, direct }) => {
    const coordinate = packages[key];
    exactKeys(coordinate, ["integrity", "version"], `packages.${key}`);
    if (!SEMVER.test(coordinate.version ?? "")) {
      fail(`${name} must have an exact semver version`);
    }
    return Object.freeze({ direct, integrity: canonicalIntegrity(coordinate.integrity, name), key, name, version: coordinate.version });
  });
}

function validateCohortWorkflow(workflow) {
  exactKeys(workflow, ["repository", "path", "revision", "blobSha"], "Cohort workflow");
  if (workflow.repository !== "agent-teams-ai/.github" ||
      workflow.path !== ".github/workflows/docs-protocol-check.yml" ||
      !COMMIT.test(workflow.revision ?? "") || !COMMIT.test(workflow.blobSha ?? "") ||
      workflow.revision === "0".repeat(40) || workflow.blobSha === "0".repeat(40)) {
    fail("Cohort workflow authority is invalid");
  }
}

function validateCohortBindings(cohort) {
  exactKeys(cohort.assets, ["skillDigest", "callerWorkflowDigest", "assetCatalogDigest", "transitionCatalogDigest"], "Cohort assets");
  if (!Object.values(cohort.assets).every((digest) => SHA256.test(digest))) {
    fail("Cohort asset authority is invalid");
  }
  exactKeys(cohort.schemas, ["consumerIntegration", "managedState", "docsProtocol"], "Cohort schemas");
  if (cohort.schemas.consumerIntegration !== 3 || cohort.schemas.managedState !== 2 || cohort.schemas.docsProtocol !== 1) {
    fail("Cohort schema tuple must be exactly 3/2/1");
  }
  exactKeys(cohort.runtime, ["node", "pnpm", "runtimeClosureDigest"], "Cohort runtime");
  if (cohort.runtime.node !== ">=24.18.0 <25" || cohort.runtime.pnpm !== ">=11.17.0 <12" ||
      !SHA256.test(cohort.runtime.runtimeClosureDigest ?? "")) {
    fail("Cohort runtime authority is invalid");
  }
}

export function parseCanaryInputs({ authorityRevision, cohortId, expectedCommit }) {
  if (!COHORT_ID.test(cohortId ?? "")) {
    fail("cohort ID must be one canonical explicit identity");
  }
  if (!COMMIT.test(authorityRevision ?? "") || authorityRevision === "0".repeat(40)) {
    fail("authority revision must be one nonzero full lowercase Git SHA");
  }
  if (!COMMIT.test(expectedCommit ?? "") || expectedCommit === "0".repeat(40)) {
    fail("expected commit must be one full lowercase Git SHA");
  }
  return Object.freeze({ authorityRevision, cohortId, expectedCommit });
}

export function createCanaryAuthority(projected, inputs) {
  exactKeys(projected, ["cohort", "path", "repository", "revision"], "projected central authority");
  if (projected.repository !== CENTRAL_AUTHORITY.repository || projected.path !== CENTRAL_AUTHORITY.path ||
      projected.revision !== inputs.authorityRevision) {
    fail("projected Cohort is not bound to the requested central authority revision");
  }
  const cohort = projected.cohort;
  exactKeys(cohort, [
    "schemaVersion", "cohortId", "channel", "recordDigest", "qualificationEventDigest",
    "eligibleAfter", "upgradeFrom", "rollbackTo", "packages", "workflow", "assets",
    "schemas", "runtime",
  ], "Cohort v2 authority");
  validateCohortIdentity(cohort);
  validateCohortTransitions(cohort);
  const coordinates = cohortCoordinates(cohort.packages);
  validateCohortWorkflow(cohort.workflow);
  validateCohortBindings(cohort);
  if (cohort.cohortId !== inputs.cohortId) {
    fail("projected Cohort identity differs from the requested Cohort");
  }
  return Object.freeze({
    cohort: Object.freeze(structuredClone(cohort)),
    coordinates: Object.freeze(coordinates),
    roots: Object.freeze(coordinates.filter(({ direct }) => direct)),
    central: Object.freeze({ ...CENTRAL_AUTHORITY, revision: inputs.authorityRevision }),
    expectedCommit: inputs.expectedCommit,
    registry: "https://registry.npmjs.org/",
    source: Object.freeze({
      ref: "refs/heads/main",
      repository: "https://github.com/agent-teams-ai/engineering-foundation",
      workflow: ".github/workflows/release.yml",
    }),
  });
}

export function assertRegistryObservations(authority, observations) {
  for (const coordinate of authority.coordinates) {
    const observation = observations[coordinate.name];
    if (observation?.integrity !== coordinate.integrity || observation?.version !== coordinate.version ||
        observation?.latest !== coordinate.version) {
      fail(`live registry identity differs from central authority for ${coordinate.name}`);
    }
  }
  return observations;
}

export function supportingMcpCoordinate(packument) {
  const exact = packument?.versions?.[SUPPORTING_MCP_PACKAGE.version];
  if (exact?.name !== SUPPORTING_MCP_PACKAGE.name ||
      exact.version !== SUPPORTING_MCP_PACKAGE.version ||
      packument?.["dist-tags"]?.latest !== SUPPORTING_MCP_PACKAGE.version) {
    fail(`supporting release package must be exact latest ${SUPPORTING_MCP_PACKAGE.name}@${SUPPORTING_MCP_PACKAGE.version}`);
  }
  return Object.freeze({
    integrity: canonicalIntegrity(exact?.dist?.integrity, SUPPORTING_MCP_PACKAGE.name),
    name: SUPPORTING_MCP_PACKAGE.name,
    version: SUPPORTING_MCP_PACKAGE.version,
  });
}

export function publicationClosureDecision(authority, observations) {
  const missing = authority.coordinates
    .filter(({ name, version }) => observations[name]?.version !== version)
    .map(({ name, version }) => `${name}@${version}`);
  return Object.freeze({ missing: Object.freeze(missing), status: missing.length === 0 ? "ready" : "rejected" });
}

function portableArchivePath(path) {
  if (typeof path !== "string" || path === "" || path.includes("\\") || path.startsWith("/") || path.normalize("NFC") !== path) {
    return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function assertSafeTarballInventory(entries, packageName) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`${packageName} tarball inventory must be non-empty`);
  }
  const exact = new Set();
  const folded = new Set();
  for (const entry of entries) {
    if (!portableArchivePath(entry)) {
      fail(`${packageName} tarball contains an unsafe path`);
    }
    const caseFolded = entry.toLocaleLowerCase("en-US");
    if (exact.has(entry) || folded.has(caseFolded)) {
      fail(`${packageName} tarball contains a duplicate or case alias`);
    }
    exact.add(entry);
    folded.add(caseFolded);
  }
  return Object.freeze([...entries]);
}

export function assertTarballEntryTypes(verboseInventory, packageName) {
  if (typeof verboseInventory !== "string" || verboseInventory.trim() === "") {
    fail(`${packageName} verbose tarball inventory must be non-empty`);
  }
  const unsafe = verboseInventory.split("\n").filter(Boolean).find((line) => line.startsWith("l") || line.startsWith("h"));
  if (unsafe !== undefined) {
    fail(`${packageName} tarball contains a symbolic or hard link`);
  }
}

export function assertPortableCoreClosure({ contents = "", dependencies, entries }) {
  if (Object.keys(dependencies ?? {}).includes("@agent-teams/docs-protocol-agent-teams")) {
    fail("portable Docs Protocol depends on the managed adapter");
  }
  const lowerEntries = [...entries.map((entry) => entry.toLowerCase()), contents.toLowerCase()];
  const found = FORBIDDEN_PORTABLE_TERMS.find((term) => lowerEntries.some((entry) => entry.includes(term)));
  if (found !== undefined) {
    fail(`portable Docs Protocol tarball contains managed authority ${found}`);
  }
  return Object.freeze({ adapterAbsent: true, forbiddenTermsAbsent: true });
}

export function evaluateHostileFixture(fixture) {
  exactKeys(fixture, ["id", "kind", "value"], "hostile fixture");
  try {
    if (fixture.kind === "publication") {
      if (publicationClosureDecision(fixture.value.authority, fixture.value.observations).status !== "rejected") {
        fail(`${fixture.id} was unexpectedly admitted`);
      }
    } else if (fixture.kind === "inventory") {
      assertSafeTarballInventory(fixture.value, fixture.id);
      fail(`${fixture.id} was unexpectedly admitted`);
    } else if (fixture.kind === "entry-type") {
      if (fixture.value?.type !== "symbolic-link") {
        fail(`${fixture.id} was unexpectedly admitted`);
      }
      throw new Error(`${fixture.id} contains a symbolic link`);
    } else {
      fail(`${fixture.id} has an unknown fixture kind`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("unexpectedly admitted")) {
      throw error;
    }
    return Object.freeze({ id: fixture.id, mode: "deterministic-policy", outcome: "rejected" });
  }
  return Object.freeze({ id: fixture.id, mode: "deterministic-policy", outcome: "rejected" });
}

export function hostilePolicyMatrix(authority) {
  const ready = Object.fromEntries(authority.coordinates.map(({ name, version }) => [name, { version }]));
  const without = (name) => Object.fromEntries(Object.entries(ready).filter(([candidate]) => candidate !== name));
  return Object.freeze([
    { id: "partial-publication", kind: "publication", value: { authority, observations: without(authority.coordinates.at(-1).name) } },
    { id: "missing-adapter", kind: "publication", value: { authority, observations: without("@agent-teams/docs-protocol-agent-teams") } },
    { id: "path-traversal", kind: "inventory", value: ["package/../escape"] },
    { id: "absolute-path", kind: "inventory", value: ["/package/index.js"] },
    { id: "backslash-alias", kind: "inventory", value: ["package\\index.js"] },
    { id: "nfc-alias", kind: "inventory", value: ["package/cafe\u0301.js"] },
    { id: "case-alias", kind: "inventory", value: ["package/File.js", "package/file.js"] },
    { id: "symbolic-link", kind: "entry-type", value: { type: "symbolic-link" } },
  ].map(evaluateHostileFixture));
}

export function finalizeCanaryReceipt(body) {
  return Object.freeze({ ...body, receiptDigest: canonicalReceiptDigest(body) });
}

export function assertCanaryReceiptDigest(receipt) {
  const { receiptDigest, ...body } = receipt;
  if (receiptDigest !== canonicalReceiptDigest(body)) {
    fail("receipt digest does not match canonical receipt body");
  }
}
