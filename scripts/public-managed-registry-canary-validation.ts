const SHA512_SRI = /^sha512-([A-Za-z0-9+/]+={0,2})$/u;
export const COHORT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
export const COHORT_PACKAGES = Object.freeze([
  Object.freeze({
    key: "repositoryMutation",
    name: "@agent-teams/repository-mutation",
    direct: false,
  }),
  Object.freeze({
    key: "documentAuthoring",
    name: "@agent-teams/document-authoring",
    direct: false,
  }),
  Object.freeze({ key: "docsProtocol", name: "@agent-teams/docs-protocol", direct: true }),
  Object.freeze({
    key: "docsProtocolAgentTeams",
    name: "@agent-teams/docs-protocol-agent-teams",
    direct: true,
  }),
  Object.freeze({
    key: "engineeringFoundation",
    name: "@agent-teams/engineering-foundation",
    direct: true,
  }),
]);
const FORBIDDEN_PORTABLE_TERMS = [
  "docs-consumer-integration",
  "managed-state",
  "qualifieddocscohort",
  "rundocsprotocolqualificationv2",
  "rundocsprotocolqualificationv3",
];
export const COHORT_V3_KEYS = [
  "schemaVersion",
  "cohortId",
  "channel",
  "recordDigest",
  "qualificationEventDigest",
  "eligibleAfter",
  "upgradeFrom",
  "rollbackTo",
  "candidateDigest",
  "packages",
  "workflow",
  "assets",
  "schemas",
  "runtime",
];
export const COHORT_V3_SCHEMA_BINDINGS = Object.freeze({
  consumerIntegration: 4,
  managedState: 3,
  qualificationReceipt: 1,
  docsProtocol: 1,
});
export const COHORT_V3_RUNTIME = Object.freeze({
  selectedLane: "node-26-managed-qualified",
  node: ">=26.0.0 <27",
  pnpm: ">=11.17.0 <12",
  qualificationRuntime: Object.freeze({
    nodeVersion: "26.11.1",
    pnpmVersion: "11.20.0",
    platform: "linux",
    architecture: "x64",
  }),
});
export function fail(message: string): never {
  throw new Error(`Public managed registry canary policy rejected: ${message}`);
}

export function exactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (Object.keys(value).toSorted().join("\0") !== [...keys].toSorted().join("\0")) {
    fail(`${label} has unexpected keys`);
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function portableArchivePath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    path === "" ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.normalize("NFC") !== path
  ) {
    return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function assertSafeTarballInventory(entries: unknown, packageName: string) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`${packageName} tarball inventory must be non-empty`);
  }
  const inventory: readonly unknown[] = entries;
  const exact = new Set();
  const folded = new Set();
  for (const entry of inventory) {
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
  return Object.freeze([...inventory]);
}

export function assertTarballEntryTypes(verboseInventory: unknown, packageName: string) {
  if (typeof verboseInventory !== "string" || verboseInventory.trim() === "") {
    fail(`${packageName} verbose tarball inventory must be non-empty`);
  }
  const unsafe = verboseInventory
    .split("\n")
    .filter(Boolean)
    .find((line) => line.startsWith("l") || line.startsWith("h"));
  if (unsafe !== undefined) {
    fail(`${packageName} tarball contains a symbolic or hard link`);
  }
}

export function assertPortableCoreClosure({
  contents = "",
  dependencies,
  entries,
}: {
  contents?: string;
  dependencies?: Readonly<Record<string, unknown>>;
  entries: readonly string[];
}) {
  if (Object.keys(dependencies ?? {}).includes("@agent-teams/docs-protocol-agent-teams")) {
    fail("portable Docs Protocol depends on the managed adapter");
  }
  const lowerEntries = [...entries.map((entry) => entry.toLowerCase()), contents.toLowerCase()];
  const found = FORBIDDEN_PORTABLE_TERMS.find((term) =>
    lowerEntries.some((entry) => entry.includes(term)),
  );
  if (found !== undefined) {
    fail(`portable Docs Protocol tarball contains managed authority ${found}`);
  }
  return Object.freeze({ adapterAbsent: true, forbiddenTermsAbsent: true });
}

export function canonicalIntegrity(value: string | undefined, label: string) {
  const match = SHA512_SRI.exec(value ?? "");
  const bytes = match === null ? undefined : Buffer.from(match.at(1) ?? "", "base64");
  if (bytes?.length !== 64 || bytes.toString("base64") !== (match?.at(1) ?? "")) {
    fail(`${label} must be a canonical sha512 SRI`);
  }
  return value;
}

export function exactCohortIds(value: unknown, label: string) {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    new Set(value).size !== value.length ||
    !value.every((entry) => typeof entry === "string" && COHORT_ID.test(entry))
  ) {
    fail(`${label} must contain unique canonical Cohort IDs`);
  }
}

export function canonicalUtcSeconds(value: string, label: string) {
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().replace(".000", "") !== value
  ) {
    fail(`${label} must be a canonical UTC timestamp with second precision`);
  }
}

interface ReceiptGeneration {
  readonly schemaVersion?: unknown;
  readonly authority?: { readonly cohort?: { readonly schemaVersion?: unknown } };
}
function expectedCanaryReceiptSchemaVersion(receipt: ReceiptGeneration | null | undefined) {
  const cohortSchemaVersion = receipt?.authority?.cohort?.schemaVersion;
  if (cohortSchemaVersion === 2) {
    return 1;
  }
  if (cohortSchemaVersion === 3) {
    return 2;
  }
  fail("receipt generation must correspond to Cohort v2 or Cohort v3");
}

export function assertCanaryReceiptGeneration(receipt: ReceiptGeneration | null | undefined) {
  const expected = expectedCanaryReceiptSchemaVersion(receipt);
  if (receipt?.schemaVersion !== expected) {
    fail(`receipt schemaVersion must be ${expected} for its Cohort generation`);
  }
}
