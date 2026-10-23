/** Vocabulary of the Feature Module Standard kernel. Pure data, no I/O, no policy beyond the standard. */
export type LayerRole =
  | "domain"
  | "application"
  | "contracts"
  | "adapters"
  | "composition"
  | "testing";
export type ImportMode = "runtime" | "type-only";
export type SurfaceKind =
  | "public"
  | "internal-api"
  | "composition-contract"
  | "composition-surface"
  | "testing";
export type RepublishedSurface = "public" | "composition-contract";

/** One resolved edge between two repository files. `reexport` marks `export ... from` forms. */
export type ImportRecord = Readonly<{
  from: string;
  to: string;
  mode: ImportMode;
  line: number;
  reexport?: boolean;
}>;

/** Curated files of the module, as the profile maps them. A file may hold several kinds. */
export type SurfaceMap = Readonly<{
  public?: readonly string[];
  internalApi?: readonly string[];
  compositionContract?: readonly string[];
  compositionSurface?: readonly string[];
  /** Testing surfaces: reachable from the tests of a visible feature, never from production code. */
  testing?: readonly string[];
}>;

/** A declared republication: `from` re-exports part of the `surface` of its direct sub-feature `to`. */
export type Republication = Readonly<{ from: string; to: string; surface: RepublishedSurface }>;
/** A declared use edge between feature identities such as `orders/discounts`. */
export type UseEdge = Readonly<{ from: string; to: string }>;

/** A directory or a single file that the profile maps to a role of the feature layout. The deepest mapped root wins. */
export type RoleRoot = Readonly<{ root: string; role: LayerRole }>;

export type FeatureModuleInput = Readonly<{
  /**
   * The profile's declaration of the tree: the root of every feature at any depth. A feature is the deepest declared root
   * that contains a path, and its parent is the declared root that directly contains it. A sub-feature exists only where
   * a root is declared inside another, so in any other module a `features` directory inside a feature keeps its v1 meaning.
   */
  featureRoots: readonly string[];
  /** Directories that hold the top-level feature directories. When given, a top-level root must sit directly in one. */
  featuresRoots?: readonly string[];
  /** Production files of the module, repository-relative with `/` separators. */
  files: readonly string[];
  /** Directories without any file, so that an empty sub-feature container can be seen. */
  emptyDirectories?: readonly string[];
  /** Directories and files the profile maps to the roles of the abstract layout; they need not be named after the role. */
  roleRoots: readonly RoleRoot[];
  /** Names of files the profile maps directly below a feature root, such as a README. */
  mappedFiles?: readonly string[];
  /** Directory of the feature test roots: `<root>/<feature>` and, below a feature, `features/<sub-feature>`. */
  testFeaturesRoot?: string;
  testFiles?: readonly string[];
  surfaces?: SurfaceMap;
  /**
   * Module-level files that are composition. Module-level code outside this list is not composition, so it may not depend on a
   * composition contract or wire a composition surface; a module that lists none has no module-level composition.
   */
  moduleComposition?: readonly string[];
  imports: readonly ImportRecord[];
  republications?: readonly Republication[];
  /** Declared use edges. When present, every observed use edge must be among them. */
  useEdges?: readonly UseEdge[];
  /** Depth past which a feature is reported as a warning. */
  depthWarning?: number;
  /** Named file groups to count per feature, for consumer growth reports. */
  fileGroups?: Readonly<Record<string, (path: string) => boolean>>;
}>;

/** Every diagnostic code the kernel can report. A SHOULD of the standard is a warning, a MUST an error. */
export const ERROR_CODES = [
  "assembly-misplaced",
  "assembly-missing",
  "composition-contract-layer",
  "composition-contract-misplaced",
  "container-empty",
  "container-file",
  "deep-import",
  "entry-unmapped",
  "feature-cycle",
  "feature-duplicate",
  "feature-root-placement",
  "feature-undeclared",
  "invalid-path",
  "layer-direction",
  "load-cycle",
  "not-visible",
  "republication-invalid",
  "republication-mismatch",
  "republication-not-sub-feature",
  "republication-skips-level",
  "republication-undeclared",
  "surface-unowned",
  "use-edge-invalid",
  "use-undeclared",
] as const;
export const WARNING_CODES = ["depth-warning", "test-misplaced", "test-unowned"] as const;
export type DiagnosticCode = (typeof ERROR_CODES)[number] | (typeof WARNING_CODES)[number];

export type Severity = "error" | "warning";
export type Diagnostic = Readonly<{
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  path?: string;
  line?: number;
}>;

export type FeatureNode = Readonly<{
  /** Parent identity followed by the own name, for example `orders/discounts`. */
  id: string;
  name: string;
  root: string;
  parent?: string;
  depth: number;
}>;

export type FeatureMetric = Readonly<{
  id: string;
  depth: number;
  subFeatures: number;
  sourceFiles: number;
  testFiles: number;
  groups: Readonly<Record<string, number>>;
}>;

export type FeatureModuleReport = Readonly<{
  ok: boolean;
  features: readonly FeatureNode[];
  diagnostics: readonly Diagnostic[];
  metrics: readonly FeatureMetric[];
}>;

export const FEATURE_CONTAINER = "features";

export const isWithin = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

const hasForbiddenCharacter = (path: string): boolean => {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code === 0x5c || code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
};

export const isPortablePath = (path: string): boolean =>
  path !== "" &&
  !path.startsWith("/") &&
  !hasForbiddenCharacter(path) &&
  path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

const warnings: ReadonlySet<string> = new Set(WARNING_CODES);

/** The severity follows the code: only the codes of a SHOULD are warnings. */
export const diagnostic = (
  code: DiagnosticCode,
  message: string,
  location: Readonly<{ path?: string; line?: number }> = {},
): Diagnostic => ({
  code,
  severity: warnings.has(code) ? "warning" : "error",
  message,
  ...location,
});

/** The standard this kernel implements, as the profile of an adopting repository pins it. */
export const STANDARD = {
  id: "agent-teams.feature-module-standard",
  version: "v1.1",
  digest: "sha256:cfa088ef7396139554fe5e3bcc839271b23299c6b60c569a3a7f1cd7c9f0bc6c",
} as const;
