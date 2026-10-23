export type Json = null | boolean | number | string | readonly Json[] | JsonRecord;
export type JsonRecord = { readonly [key: string]: Json };
export type LeafShape =
  | Readonly<{ type: "file"; mode: "100644" | "100755" }>
  | Readonly<{ type: "symlink"; mode: "120000" }>
  | Readonly<{ type: "gitlink"; mode: "160000" }>;
/** Digest fields use sha256:<64 lowercase hexadecimal characters>. Hashing belongs to the Host. */
export type FileLeaf = LeafShape & Readonly<{ digest: string }>;
export type ManifestSnapshot = Readonly<{ file: FileLeaf; semantic: JsonRecord }>;
export type InputBinding = Readonly<{
  source: Readonly<{ repository: string; identity: string; digest: string }>;
  engine: Readonly<{ name: string; version: string; digest: string }>;
  configDigest: string;
  inventoryDigest: string;
  policyDigest: string;
  intentsDigest: string;
  planDigest: string;
}>;
export type WorkspacePackage = Readonly<{
  name: string;
  root: string;
  manifestPath: string;
  classification: "public" | "private";
  versioning: "versioned" | "unversioned" | "ignored";
  before: ManifestSnapshot;
}>;
export type ReleaseType = "major" | "minor" | "patch";
export type ReleaseIntent = Readonly<{
  id: string;
  path: string;
  digest: string;
  participation: "pending" | "retained";
  requests: readonly Readonly<{ packageName: string; type: ReleaseType }>[];
}>;
export type PlannedRelease = Readonly<{
  packageName: string;
  manifestPath: string;
  type: ReleaseType | "none";
  oldVersion: string | null;
  newVersion: string | null;
  intentIds: readonly string[];
}>;
export type ConsumptionEffect =
  | Readonly<{ kind: "remove" }>
  | Readonly<{ kind: "record"; evidencePath: string }>;
export type PlannedConsumption = Readonly<{ intentId: string; effect: ConsumptionEffect }>;
export type ChangeKind = "added" | "modified" | "deleted";
export type PermittedChange = Readonly<{
  path: string;
  classification: string;
  kind: ChangeKind;
  before: LeafShape | null;
  after: LeafShape | null;
  contentAuthority: string;
}>;
export type ExpectedInputs = Readonly<{
  binding: InputBinding;
  packages: readonly WorkspacePackage[];
  intents: readonly ReleaseIntent[];
  plan: Readonly<{
    releases: readonly PlannedRelease[];
    consumptions: readonly PlannedConsumption[];
  }>;
  permittedChanges: readonly PermittedChange[];
}>;
export type ObservedManifest = Readonly<{
  manifestPath: string;
  before: ManifestSnapshot | null;
  after: ManifestSnapshot | null;
}>;
export type ObservedConsumption = Readonly<{
  intentId: string;
  digest: string;
  effect: ConsumptionEffect;
}>;
export type FileChange = Readonly<{
  path: string;
  classification: string;
  kind: ChangeKind;
  before: FileLeaf | null;
  after: FileLeaf | null;
}>;
export type ObservedCandidate = Readonly<{
  binding: InputBinding;
  candidateIdentity: string;
  manifests: readonly ObservedManifest[];
  consumptions: readonly ObservedConsumption[];
  diff: readonly FileChange[];
}>;
export type ReleaseCandidateInput = Readonly<{
  schemaVersion: 1;
  expected: ExpectedInputs;
  observed: ObservedCandidate;
}>;
export type PackageChange = Readonly<{
  packageName: string;
  manifestPath: string;
  oldVersion: string | null;
  newVersion: string | null;
}>;
export type DiagnosticCode =
  | "input.invalid"
  | "identity.duplicate"
  | "inventory.ambiguous"
  | "binding.mismatch"
  | "package.unknown"
  | "manifest.missing"
  | "manifest.identity"
  | "manifest.source-mismatch"
  | "manifest.content-changed"
  | "plan.version-mismatch"
  | "plan.unexpected-version"
  | "intent.unknown"
  | "intent.coverage"
  | "intent.consumption"
  | "diff.unexpected"
  | "diff.inconsistent";
export type Diagnostic = Readonly<{
  code: DiagnosticCode;
  packageName?: string;
  path?: string;
  intentId?: string;
  message: string;
}>;
export type CheckReport =
  | Readonly<{
      schemaVersion: 1;
      outcome: "passed";
      diagnostics: readonly [];
      packageChanges: readonly PackageChange[];
    }>
  | Readonly<{
      schemaVersion: 1;
      outcome: "rejected";
      diagnostics: readonly Diagnostic[];
      packageChanges: readonly PackageChange[];
    }>;
