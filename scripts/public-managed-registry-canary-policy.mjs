import { createHash } from "node:crypto";

import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";

const SHA512_SRI = /^sha512-([A-Za-z0-9+/]+={0,2})$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const FORBIDDEN_PORTABLE_TERMS = [
  "docs-consumer-integration",
  "managed-state",
  "qualifieddocscohort",
  "rundocsprotocolqualificationv2",
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

function syntheticSha256(character) {
  return `sha256:${character.repeat(64)}`;
}

function canonicalIntegrity(value, label) {
  const match = SHA512_SRI.exec(value ?? "");
  const bytes = match === null ? undefined : Buffer.from(match[1], "base64");
  if (bytes?.length !== 64 || bytes.toString("base64") !== match[1]) {
    fail(`${label} must be a canonical sha512 SRI`);
  }
  return value;
}

export function parseCanaryAuthority(input, expectedCommit) {
  if (!COMMIT.test(expectedCommit ?? "")) {
    fail("expected commit must be one full lowercase Git SHA");
  }
  let value;
  try {
    value = JSON.parse(input);
  } catch {
    fail("coordinates input must be JSON");
  }
  if (!Array.isArray(value) || value.length !== PUBLISHABLE_PACKAGES.length) {
    fail(`coordinates must contain exactly ${PUBLISHABLE_PACKAGES.length} packages`);
  }
  const expectedNames = PUBLISHABLE_PACKAGES.map(({ name }) => name);
  const coordinates = value.map((coordinate, index) => {
    exactKeys(coordinate, ["integrity", "name", "version"], `coordinates[${index}]`);
    if (coordinate.name !== expectedNames[index]) {
      fail(`coordinates[${index}] must be ${expectedNames[index]}`);
    }
    if (!SEMVER.test(coordinate.version ?? "")) {
      fail(`${coordinate.name} must have an exact semver version`);
    }
    return Object.freeze({
      integrity: canonicalIntegrity(coordinate.integrity, coordinate.name),
      name: coordinate.name,
      version: coordinate.version,
    });
  });
  return Object.freeze({
    coordinates: Object.freeze(coordinates),
    expectedCommit,
    registry: "https://registry.npmjs.org/",
    source: Object.freeze({
      ref: "refs/heads/main",
      repository: "https://github.com/agent-teams-ai/engineering-foundation",
      workflow: ".github/workflows/release.yml",
    }),
  });
}

export function publicationClosureDecision(authority, observations) {
  const missing = authority.coordinates
    .filter(({ name, version }) => observations[name]?.version !== version)
    .map(({ name, version }) => `${name}@${version}`);
  return Object.freeze({ missing: Object.freeze(missing), status: missing.length === 0 ? "ready" : "rejected" });
}

function portableArchivePath(path) {
  if (typeof path !== "string" || path === "" || path.includes("\\") || path.startsWith("/") ||
      path.normalize("NFC") !== path) {
    return false;
  }
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
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
  const unsafe = verboseInventory.split("\n").filter(Boolean).find((line) =>
    line.startsWith("l") || line.startsWith("h"));
  if (unsafe !== undefined) {
    fail(`${packageName} tarball contains a symbolic or hard link`);
  }
}

export function assertPortableCoreClosure({ contents = "", dependencies, entries }) {
  const dependencyNames = Object.keys(dependencies ?? {});
  if (dependencyNames.includes("@agent-teams/docs-protocol-agent-teams")) {
    fail("portable Docs Protocol depends on the managed adapter");
  }
  const lowerEntries = [...entries.map((entry) => entry.toLowerCase()), contents.toLowerCase()];
  const found = FORBIDDEN_PORTABLE_TERMS.find((term) =>
    lowerEntries.some((entry) => entry.includes(term)));
  if (found !== undefined) {
    fail(`portable Docs Protocol tarball contains managed authority ${found}`);
  }
  return Object.freeze({ adapterAbsent: true, forbiddenTermsAbsent: true });
}

export function assertTransactionPrecondition({ actualDigest, expectedDigest, phase }) {
  if (phase !== "active") {
    fail(`transaction phase ${String(phase)} is not active`);
  }
  if (actualDigest !== expectedDigest) {
    fail("transaction preimage digest is stale");
  }
}

export function evaluateHostileFixture(fixture) {
  exactKeys(fixture, ["id", "kind", "value"], "hostile fixture");
  try {
    if (fixture.kind === "publication") {
      const decision = publicationClosureDecision(fixture.value.authority, fixture.value.observations);
      if (decision.status !== "rejected") {
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
    } else if (fixture.kind === "transaction") {
      exactKeys(fixture.value, ["actualDigest", "expectedDigest", "phase"], fixture.id);
      assertTransactionPrecondition(fixture.value);
      fail(`${fixture.id} was unexpectedly admitted`);
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
    { id: "interruption-before-staging", kind: "transaction", value: { phase: "interrupted", expectedDigest: syntheticSha256("a"), actualDigest: syntheticSha256("b") } },
    { id: "cancellation", kind: "transaction", value: { phase: "cancelled", expectedDigest: syntheticSha256("a"), actualDigest: syntheticSha256("b") } },
    { id: "stale-transaction", kind: "transaction", value: { phase: "stale", expectedDigest: syntheticSha256("a"), actualDigest: syntheticSha256("b") } },
    { id: "foreign-change", kind: "transaction", value: { phase: "foreign-change", expectedDigest: syntheticSha256("a"), actualDigest: syntheticSha256("b") } },
  ].map(evaluateHostileFixture));
}

export function finalizeCanaryReceipt(body) {
  const receiptDigest = canonicalReceiptDigest(body);
  return Object.freeze({ ...body, receiptDigest });
}

export function assertCanaryReceiptDigest(receipt) {
  const { receiptDigest, ...body } = receipt;
  if (receiptDigest !== canonicalReceiptDigest(body)) {
    fail("receipt digest does not match canonical receipt body");
  }
}
