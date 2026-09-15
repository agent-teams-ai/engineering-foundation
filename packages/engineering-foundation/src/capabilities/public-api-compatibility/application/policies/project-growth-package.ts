import type { WorkspacePackage } from "../../../../workspace-inventory/api.js";
import type { GrowthCoverage, GrowthCoordinate, GrowthSurfaceObservation, GrowthResolutionTree } from "../model/growth-observation.js";
import { GrowthObservationInvariantError, GrowthObservationUnavailableError, growthDimensions } from "../model/growth-observation.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import type { GrowthCompatibilitySubject, RetainedGrowthCompatibility } from "./retain-growth-compatibility.js";
import { growthCanonicalJson, growthUniqueSorted } from "./normalize-growth-observation.js";
import { growthDeclarationBranches, projectGrowthResolution } from "./project-growth-resolution.js";
import { assertPackageExportCoverage, observedPackageExports, PackageExportCoverageError } from "./validate-package-export-coverage.js";
import type { PublicApiSnapshot, PublicApiArtifactSnapshot } from "../model/public-api.js";
import type { ObservedPackageExport } from "./validate-package-export-coverage.js";
import { wildcardExpression } from "./compare-package-artifact-inventory.js";

export interface GrowthPackageProjection {
  readonly coverage: GrowthCoverage;
  readonly entries: GrowthSurfaceObservation["entries"];
}

/** Bounded projection of existing observer results. Unsupported dimensions stay
 * explicit; declaration evidence never establishes runtime, bin or packed facts.
 */
export function projectGrowthPackage(input: {
  readonly pkg: WorkspacePackage;
  readonly subject: GrowthCompatibilitySubject | undefined;
  readonly retained: RetainedGrowthCompatibility | undefined;
}, fingerprint: ChangeFingerprint): GrowthPackageProjection {
  const { pkg, subject, retained } = input;
  const entries: GrowthSurfaceObservation["entries"][number][] = [];
  const dimensions = new Map<GrowthCoverage["dimensions"][number]["dimension"], GrowthCoverage["dimensions"][number]>();
  function coverage(dimension: GrowthCoverage["dimensions"][number]["dimension"], status: GrowthCoverage["dimensions"][number]["status"], reason: string): void {
    dimensions.set(dimension, { dimension, status, reasons: [reason] });
  }
  function present(coordinate: Omit<GrowthCoordinate, "packageName">, value: unknown): void {
    if (entries.length >= 100_000) { throw new GrowthObservationUnavailableError("growth-entry-budget-exhausted"); }
    entries.push({ coordinate: { packageName: pkg.name, ...coordinate }, value: { state: "present", digest: `sha256:${fingerprint.sha256(growthCanonicalJson(value))}` } });
  }
  coverage("topology", "limited", "workspace-topology-observed-source-binding-unverified");
  coverage("resolution", "limited", "ordered-export-tree-only");
  coverage("typed", "unavailable", "typed-observation-unavailable");
  coverage("reachable", "unsupported", "bounded-graph-input-not-supplied");
  coverage("runtime", "unsupported", "runtime-symbol-census-unsupported");
  coverage("bin", "unsupported", "named-bin-observation-unsupported");
  coverage("data", "unsupported", "standalone-data-content-unsupported");
  coverage("wildcard", "unavailable", "artifact-observation-unavailable");
  coverage("packed", "unavailable", "exact-packed-qualification-unavailable");
  coverage("decision", "unavailable", "s1-decision-evidence-unavailable");
  present({ exportPath: ".", resolutionBranch: [], subject: { kind: "package" } }, {
    packageName: pkg.name, rootPath: pkg.rootPath, manifestPath: pkg.manifestPath, moduleType: pkg.moduleType,
    classification: "governed", explicitExports: pkg.exportSurface.explicit
  });
  const exports = growthUniqueSorted(pkg.exportSurface.entries, (entry) => entry.subpath);
  const trees = new Map<string, GrowthResolutionTree>();
  for (const entry of exports) {
    if (entry.target === undefined) {
      coverage("resolution", "unavailable", "export-target-observation-unavailable");
      continue;
    }
    const tree = projectGrowthResolution(entry.target);
    trees.set(entry.subpath, tree);
    present({ exportPath: entry.subpath, resolutionBranch: [], subject: { kind: "export-branch" } }, tree);
  }
  if (!pkg.exportSurface.explicit || exports.length === 0) {
    coverage("resolution", "unsupported", "no-exports-map-unsupported");
    coverage("typed", "unsupported", "no-declared-entrypoint");
  } else if (subject !== undefined && retained !== undefined) {
    // Feed the already-observed inert targets to the existing coverage policy.
    // This neither reparses package bytes nor introduces a second export census.
    const manifest = { exports: Object.fromEntries(exports.map((entry) => [entry.subpath, entry.target])) };
    let admitted = false;
    try { assertPackageExportCoverage({ manifest, policy: subject.policy }); admitted = true; }
    catch (error) {
      if (!(error instanceof PackageExportCoverageError)) { throw error; }
      coverage("typed", "unsupported", "export-coverage-unsupported-or-incomplete");
      coverage("wildcard", "unsupported", "export-coverage-unsupported-or-incomplete");
    }
    if (admitted) {
      const observed = observedPackageExports({ manifest, policy: subject.policy });
      if (retained.compatibility.typed.snapshot.status === "available") {
        projectTyped({ snapshot: retained.compatibility.typed.snapshot.value, pkg, trees, observed }, present);
        coverage("typed", "limited", "release-declarations-only-no-hidden-or-runtime-guarantee");
      }
      if (retained.artifactObservation.status === "available") {
        projectWildcard({ artifact: retained.artifactObservation.value, observed }, present);
        coverage("wildcard", "limited", "wildcard-membership-and-schema-bytes-only");
      }
    }
  }
  return { coverage: { packageName: pkg.name, classification: "governed", dimensions: growthDimensions.map((dimension) => dimensions.get(dimension)!) }, entries };
}

type Present = (coordinate: Omit<GrowthCoordinate, "packageName">, value: unknown) => void;

function projectTyped(input: {
  readonly snapshot: PublicApiSnapshot; readonly pkg: WorkspacePackage;
  readonly trees: ReadonlyMap<string, GrowthResolutionTree>; readonly observed: readonly ObservedPackageExport[];
}, present: Present): void {
  const { snapshot, pkg, trees, observed } = input;
  const actual = growthUniqueSorted(snapshot.entrypoints, (entry) => entry.exportPath);
  const expected = observed.filter((entry) => entry.kind === "typed");
  if (growthCanonicalJson(actual.map((entry) => entry.exportPath)) !== growthCanonicalJson(expected.map((entry) => entry.exportPath))) {
    throw new GrowthObservationInvariantError("typed-entrypoint-observation-mismatch");
  }
  for (const entry of actual) {
    const target = expected.find((candidate) => candidate.exportPath === entry.exportPath)?.declarationEntryPoint;
    const prefix = pkg.rootPath === "." ? "" : `${pkg.rootPath}/`;
    const tree = trees.get(entry.exportPath);
    const branches = target === undefined || !target.startsWith(prefix) || tree === undefined ? [] : growthDeclarationBranches(tree, `./${target.slice(prefix.length)}`);
    if (branches.length === 0) { throw new GrowthObservationInvariantError("typed-declaration-branch-unavailable"); }
    for (const item of growthUniqueSorted(entry.items, (candidate) => candidate.canonicalReference)) {
      for (const resolutionBranch of branches) {
        present({ exportPath: entry.exportPath, resolutionBranch, subject: { kind: "typed", canonicalReference: item.canonicalReference } }, item);
      }
    }
  }
}

function projectWildcard(input: {
  readonly artifact: PublicApiArtifactSnapshot; readonly observed: readonly ObservedPackageExport[];
}, present: Present): void {
  const { artifact, observed } = input;
  const schemas = new Map(growthUniqueSorted(artifact.jsonSchemas, (schema) => schema.path).map((schema) => [schema.path, schema]));
  const wildcards = growthUniqueSorted(artifact.wildcardExports, (entry) => entry.exportPath);
  const expected = observed.filter((entry) => entry.kind === "wildcard");
  if (growthCanonicalJson(wildcards.map((entry) => [entry.exportPath, entry.targetPattern])) !== growthCanonicalJson(expected.map((entry) => [entry.exportPath, entry.targetPattern]))) {
    throw new GrowthObservationInvariantError("artifact-wildcard-observation-mismatch");
  }
  for (const wildcard of wildcards) {
    const expression = wildcardExpression(wildcard.targetPattern);
    for (const member of growthUniqueSorted(wildcard.members, (value) => value)) {
      const capture = expression.exec(member)?.[1];
      if (capture === undefined) { throw new GrowthObservationInvariantError("artifact-member-outside-pattern"); }
      const schema = schemas.get(member);
      const exportPath = wildcard.exportPath.replace("*", capture);
      present({ exportPath, resolutionBranch: [], subject: { kind: "wildcard-member", member: exportPath } },
        schema === undefined ? { member } : { member, id: schema.id, digest: schema.digest });
    }
  }
}
