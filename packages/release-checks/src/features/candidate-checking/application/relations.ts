import type {
  Diagnostic,
  DiagnosticCode,
  FileChange,
  JsonRecord,
  ObservedConsumption,
  ObservedManifest,
  PermittedChange,
  PlannedConsumption,
  PlannedRelease,
  ReleaseCandidateInput,
  ReleaseIntent,
  WorkspacePackage,
} from "./model.js";

export const ordinal = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
export function same(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value: unknown, position) => same(value, right[position]))
    );
  }
  const a = left as Readonly<Record<string, unknown>>;
  const b = right as Readonly<Record<string, unknown>>;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
  );
}
export function version(semantic: JsonRecord): string | null {
  return typeof semantic["version"] === "string" ? semantic["version"] : null;
}
export function nonVersion(semantic: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(semantic).filter(([key]) => key !== "version"));
}
type Location = Pick<Diagnostic, "packageName" | "path" | "intentId">;
export function reject(
  diagnostics: Diagnostic[],
  code: DiagnosticCode,
  location: Location,
  message: string,
): void {
  diagnostics.push(Object.freeze({ code, ...location, message }));
}
export interface CandidateFacts {
  readonly packages: ReadonlyMap<string, WorkspacePackage>;
  readonly manifests: ReadonlyMap<string, WorkspacePackage>;
  readonly intents: ReadonlyMap<string, ReleaseIntent>;
  readonly intentPaths: ReadonlyMap<string, ReleaseIntent>;
  readonly releases: ReadonlyMap<string, PlannedRelease>;
  readonly consumptions: ReadonlyMap<string, PlannedConsumption>;
  readonly permissions: ReadonlyMap<string, PermittedChange>;
  readonly observedManifests: ReadonlyMap<string, ObservedManifest>;
  readonly observedConsumptions: ReadonlyMap<string, ObservedConsumption>;
  readonly diff: ReadonlyMap<string, FileChange>;
}
function index<T>(
  values: readonly T[],
  key: (value: T) => string,
  diagnostics: Diagnostic[],
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const identity = key(value);
    if (result.has(identity)) {
      reject(
        diagnostics,
        "identity.duplicate",
        { path: identity },
        `Duplicate ${label}: ${identity}.`,
      );
    }
    result.set(identity, value);
  }
  return result;
}
export function candidateFacts(
  input: ReleaseCandidateInput,
  diagnostics: Diagnostic[],
): CandidateFacts {
  const { expected, observed } = input;
  const packages = index(expected.packages, (p) => p.name, diagnostics, "package name");
  const manifests = index(expected.packages, (p) => p.manifestPath, diagnostics, "manifest path");
  index(expected.packages, (p) => p.root, diagnostics, "package root");
  if (expected.packages.length === 0) {
    reject(
      diagnostics,
      "inventory.ambiguous",
      {},
      "The classified inventory must contain at least one actual package.",
    );
  }
  for (const p of expected.packages) {
    if (p.manifestPath !== (p.root === "." ? "package.json" : `${p.root}/package.json`)) {
      reject(
        diagnostics,
        "inventory.ambiguous",
        { packageName: p.name, path: p.manifestPath },
        "Manifest path does not identify its declared package root.",
      );
    }
  }
  const intents = index(expected.intents, (intent) => intent.id, diagnostics, "intent identity");
  const intentPaths = index(expected.intents, (intent) => intent.path, diagnostics, "intent path");
  for (const intent of expected.intents) {
    index(
      intent.requests,
      (request) => request.packageName,
      diagnostics,
      `request in ${intent.id}`,
    );
    if (manifests.has(intent.path)) {
      reject(
        diagnostics,
        "inventory.ambiguous",
        { path: intent.path, intentId: intent.id },
        "A manifest path cannot also identify a release intent.",
      );
    }
  }
  const releases = index(
    expected.plan.releases,
    (release) => release.packageName,
    diagnostics,
    "planned package",
  );
  index(expected.plan.releases, (release) => release.manifestPath, diagnostics, "planned manifest");
  for (const release of expected.plan.releases) {
    index(release.intentIds, (id) => id, diagnostics, `intent link for ${release.packageName}`);
  }
  return {
    packages,
    manifests,
    intents,
    intentPaths,
    releases,
    consumptions: index(
      expected.plan.consumptions,
      (entry) => entry.intentId,
      diagnostics,
      "planned consumption",
    ),
    permissions: index(
      expected.permittedChanges,
      (entry) => entry.path,
      diagnostics,
      "permitted path",
    ),
    observedManifests: index(
      observed.manifests,
      (entry) => entry.manifestPath,
      diagnostics,
      "observed manifest",
    ),
    observedConsumptions: index(
      observed.consumptions,
      (entry) => entry.intentId,
      diagnostics,
      "observed consumption",
    ),
    diff: index(observed.diff, (entry) => entry.path, diagnostics, "diff path"),
  };
}
