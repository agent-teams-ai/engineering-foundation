import type { MigrationDigest, NativeMigrationReview } from "./public-api-native-migration.ts";
export const migrationSourceCommit = "4b9cc2165563361f463ca3c59277edc9af592c55";
export interface Origin {
  readonly name: string;
  readonly version: string;
  readonly publicationSourceCommit: string | null;
}
export interface NativeMigrationIntent {
  readonly kind: "foundation:public-api-native-migration:inputs:1";
  readonly review: NativeMigrationReview;
  readonly origins: readonly Origin[];
  readonly npmVersion: "11.19.0";
  readonly dependencyManifestDigest: MigrationDigest;
  readonly dependencyLockDigest: MigrationDigest;
  readonly qualifiedArchiveLogDigest: MigrationDigest;
  readonly expectedCapabilities: readonly {
    readonly capabilityId: string;
    readonly capabilityConfigSchemaVersion: number;
  }[];
}

export function fail(message: string): never {
  throw new Error(`Native migration inputs: ${message}`);
}
export function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).toSorted().join("\0") !== expected.toSorted().join("\0")) {
    fail("unexpected input fields");
  }
}
export function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("nonempty string required");
  }
  return value;
}
export function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail("array required");
  }
  return value;
}
export function digest(value: unknown): MigrationDigest {
  const text = string(value);
  if (!/^sha256:[a-f0-9]{64}$/u.test(text)) {
    fail("SHA-256 digest required");
  }
  return text as MigrationDigest;
}

function readReview(source: unknown): NativeMigrationReview {
  const input = record(source, "review");
  keys(input, [
    "kind",
    "from",
    "to",
    "baselineSourceCommit",
    "policyDigest",
    "toolDiffDigest",
    "packages",
  ]);
  if (
    input["kind"] !== "foundation:public-api-native-migration:review:1" ||
    input["from"] !== "7.58.12" ||
    input["to"] !== "typescript-native/7.0.2" ||
    input["baselineSourceCommit"] !== migrationSourceCommit
  ) {
    fail("only the reviewed 7.58.12 to native 7.0.2 transition is supported");
  }
  const packages = list(input["packages"]).map((value) => {
    const row = record(value, "reviewed package");
    keys(row, [
      "packageName",
      "baselinePath",
      "baselineDigest",
      "archiveDigest",
      "archiveIntegrity",
      "configDigest",
      "releasedInputsDigest",
      "nativeReleasedDigest",
    ]);
    return {
      packageName: string(row["packageName"]),
      baselinePath: string(row["baselinePath"]),
      baselineDigest: digest(row["baselineDigest"]),
      archiveDigest: digest(row["archiveDigest"]),
      archiveIntegrity: string(row["archiveIntegrity"]),
      configDigest: digest(row["configDigest"]),
      releasedInputsDigest: digest(row["releasedInputsDigest"]),
      nativeReleasedDigest: digest(row["nativeReleasedDigest"]),
    };
  });
  return {
    kind: input["kind"],
    from: input["from"],
    to: input["to"],
    baselineSourceCommit: migrationSourceCommit,
    policyDigest: digest(input["policyDigest"]),
    toolDiffDigest: digest(input["toolDiffDigest"]),
    packages,
  };
}

export function parseNativeMigrationIntent(source: unknown): NativeMigrationIntent {
  const input = record(source, "migration input");
  keys(input, [
    "kind",
    "review",
    "origins",
    "npmVersion",
    "dependencyManifestDigest",
    "dependencyLockDigest",
    "qualifiedArchiveLogDigest",
    "expectedCapabilities",
  ]);
  if (
    input["kind"] !== "foundation:public-api-native-migration:inputs:1" ||
    input["npmVersion"] !== "11.19.0"
  ) {
    fail("unsupported migration input or npm version");
  }
  const review = readReview(input["review"]);
  const origins = list(input["origins"]).map((value) => {
    const row = record(value, "archive origin");
    keys(row, ["name", "version", "publicationSourceCommit"]);
    const name = string(row["name"]);
    const version = string(row["version"]);
    const commit = row["publicationSourceCommit"];
    if (
      !/^\d+\.\d+\.\d+$/u.test(version) ||
      (name === "@agent-teams/feature-module-standard"
        ? commit !== null
        : typeof commit !== "string" || !/^[a-f0-9]{40}$/u.test(commit))
    ) {
      fail("historical publication/qualification origin differs");
    }
    return { name, version, publicationSourceCommit: commit as string | null };
  });
  if (
    new Set(origins.map((row) => row.name)).size !== origins.length ||
    origins
      .map((row) => row.name)
      .toSorted()
      .join("\0") !==
      review.packages
        .map((row) => row.packageName)
        .toSorted()
        .join("\0")
  ) {
    fail("archive origin inventory differs from review");
  }
  const expectedCapabilities = list(input["expectedCapabilities"]).map((value) => {
    const row = record(value, "capability");
    keys(row, ["capabilityId", "capabilityConfigSchemaVersion"]);
    const version = row["capabilityConfigSchemaVersion"];
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
      fail("invalid capability version");
    }
    return { capabilityId: string(row["capabilityId"]), capabilityConfigSchemaVersion: version };
  });
  return {
    kind: input["kind"],
    review,
    origins,
    npmVersion: input["npmVersion"],
    expectedCapabilities,
    dependencyManifestDigest: digest(input["dependencyManifestDigest"]),
    dependencyLockDigest: digest(input["dependencyLockDigest"]),
    qualifiedArchiveLogDigest: digest(input["qualifiedArchiveLogDigest"]),
  };
}
