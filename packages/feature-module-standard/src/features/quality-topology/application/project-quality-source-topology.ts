/** Consumer-owned technical roots; this wire shape does not require FMS in its consumer. */
export interface QualitySourceTopology {
  readonly schemaVersion: 1;
  readonly censusRoots: readonly string[];
  readonly packageRoots: readonly string[];
  readonly sourceRoots: readonly string[];
  readonly testRoots: readonly string[];
  readonly excludedRoots: readonly string[];
  readonly toolingFiles: readonly string[];
}

function invalid(message: string): never {
  throw new TypeError(`FMS quality topology: ${message}`);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("expected a profile data object.");
  }
  return Object.fromEntries(Object.entries(value));
}

function path(value: unknown, allowRoot = true): string {
  if (allowRoot && value === ".") {
    return value;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 240 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.includes(":") ||
    /[*?[\]{}]/u.test(value) ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    invalid("expected a canonical repository-relative path.");
  }
  return value;
}

function paths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    invalid("expected a bounded path list.");
  }
  return value.map((item: unknown) => path(item));
}

function modules(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5000) {
    invalid("expected a nonempty bounded module mapping.");
  }
  return value.map(record);
}

function unique(values: readonly string[]): readonly string[] {
  const result = [...new Set(values)].toSorted();
  const portable = new Set(
    result.map((entry) => entry.normalize("NFC").toLocaleLowerCase("en-US")),
  );
  if (result.length > 10000 || portable.size !== result.length) {
    invalid("projected paths require bounded unique portable identities.");
  }
  return Object.freeze(result);
}

function topology(input: Omit<QualitySourceTopology, "schemaVersion">): QualitySourceTopology {
  return Object.freeze({
    schemaVersion: 1,
    censusRoots: unique(input.censusRoots),
    packageRoots: unique([".", ...input.packageRoots]),
    sourceRoots: unique(input.sourceRoots),
    testRoots: unique(input.testRoots),
    excludedRoots: unique(input.excludedRoots),
    toolingFiles: unique(input.toolingFiles),
  });
}

function generators(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 5000) {
    invalid("expected bounded generated provenance records.");
  }
  return value.map((item: unknown) => path(record(item)["generator"], false));
}

function below(source: string, root: string): boolean {
  return root === "." || source === root || source.startsWith(`${root}/`);
}

function flat(input: Record<string, unknown>, sourcePolicyPath: string): QualitySourceTopology {
  if (record(input["topology"])["sourcePolicy"] !== sourcePolicyPath) {
    invalid("the accepted source-policy mapping differs from the requested policy.");
  }
  const entries = modules(input["modules"]);
  const applications = paths(input["applicationRoots"]);
  return topology({
    censusRoots: [...paths(input["productionRoots"]), ...applications],
    packageRoots: entries.map((entry) => path(entry["root"])),
    sourceRoots: [...entries.map((entry) => path(entry["sourceRoot"])), ...applications],
    testRoots: entries.flatMap((entry) => paths(entry["testRoots"])),
    excludedRoots: paths(input["excludedRoots"]),
    toolingFiles: entries.flatMap((entry) => generators(entry["generatedRoots"])),
  });
}

function nested(input: Record<string, unknown>): QualitySourceTopology {
  const scope = record(input["scope"]);
  const adoption = record(input["adoption"]);
  const entries = modules(scope["productionModules"]);
  const layouts = modules(record(adoption["abstractLayout"])["modules"]);
  for (const layout of layouts) {
    if (
      !entries.some(
        (entry) =>
          entry["moduleRoot"] === layout["moduleRoot"] &&
          entry["sourceRoot"] === layout["sourceRoot"],
      )
    ) {
      invalid("an abstract layout must map an existing production module and its source root.");
    }
  }
  const applications = paths(adoption["applicationRoots"]);
  const applicationSources =
    applications.length === 0
      ? []
      : paths(scope["productionRoots"]).filter((source) =>
          applications.some((root) => below(source, root)),
        );
  for (const root of applications) {
    if (!applicationSources.some((source) => below(source, root))) {
      invalid("an application must map an existing production source root.");
    }
  }
  return topology({
    censusRoots: [...paths(scope["workspaceContainers"]), ...applications],
    packageRoots: entries.map((entry) => path(entry["moduleRoot"])),
    sourceRoots: [...entries.map((entry) => path(entry["sourceRoot"])), ...applicationSources],
    testRoots: layouts.map((entry) => path(entry["testRoot"])),
    excludedRoots: paths(adoption["excludedRoots"]),
    toolingFiles: [],
  });
}

/** Project supported FMS v1/v1.1 profile facts without filesystem access or policy execution. */
export function projectQualitySourceTopology(
  profile: unknown,
  sourcePolicyPath: string,
): QualitySourceTopology {
  path(sourcePolicyPath, false);
  const input = record(profile);
  const isNested = input["authority"] !== undefined;
  const standard = record(isNested ? input["authority"] : input["standard"]);
  if (
    input["schemaVersion"] !== 1 ||
    standard["id"] !== "agent-teams.feature-module-standard" ||
    (standard["version"] !== "v1" && standard["version"] !== "v1.1")
  ) {
    invalid("requires an FMS v1 or v1.1 production mapping.");
  }
  return isNested ? nested(input) : flat(input, sourcePolicyPath);
}
