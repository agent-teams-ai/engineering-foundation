# SDK growth C0 contract

Status: Documentation contract frozen as `foundation:sdk-growth:c0:5`;
implementation and activation pending S1–S3. This is a repository-only
pseudo-contract, not a published schema, command, accepted ADR or approval.
The existing [public API policy](../architecture/public-api-compatibility.md)
and its supported v1 consumers retain their current meaning and bytes.

## Exact EF checkpoint

Observed sourceBase (inventory/matrix `integrationBase`): `576ca17ea28c3df7109e99abdd4bd7cc7e89854a`.
Source tree: `2c902edd827594322a833476749c9639ae702224`.
Revision 5 execution-contract start HEAD is
`f4fdbbedba776a8f83dfdcd238bdd4c64309c84e`, tree
`402524bb5a3789c4a02088d4bbe1ca0c253c7494`. Inventory and matrix retain their
revision 4 bytes; revision 5 supersedes the execution vocabulary only.
The branch implementation head at the earlier revision 4 refresh start is
`ca7fbfd981727989b879cc0d87af7be5b2d2c39b`; it is not the observed sourceBase.
Revision 3 observed `59c50d468d77eccc27b52869fe68825bc1f27e40`.
Its delta to `ae17a36d51e26b6c1012ab9e5ffdc433e322742e` changes only
quality-coverage source-root deduplication, its tests and the release changeset;
no C0 observer or architectural verdict input changes there.
The independently compared `ae17a36d51e26b6c1012ab9e5ffdc433e322742e..576ca17ea28c3df7109e99abdd4bd7cc7e89854a`
delta is exactly release commit `576ca17` and five files: it removes
`.changeset/quiet-roots-deduplicate.md`, adds the Foundation changelog release
text, and advances Foundation from 1.3.2 to 1.3.3 in its package manifest and both
`architecture/public-api/engineering-foundation.json` and
`architecture/public-api/engineering-foundation.artifacts.json`.
Both public API artifacts change only `packageVersion`; declaration and wildcard
observations retain their previous meaning. Exact artifact bytes are hashed in
the inventory. Exports, bins, other manifests, lockfile, workspace, FMS
profile/standard, retained v1 schemas, workflows and observer implementations are
unchanged by the release. These are existing base changes, not C0 implementation.
Revision 4 is a delta-sensitive evidence refresh of exact source and release
identities; it does not broaden supported shapes or claims or authorize implementation.
GM and AR checkpoint identities and observations remain unchanged.
The release workflow still preserves ordered publication with a 60-minute release
job and `cancel-in-progress:false`; its separate release-PR attestation remains.
S3 must qualify authority against this exact integration workflow. Remote
freshness is not claimed. The [inventory](sdk-growth-c0/ef-inventory.json) records every
workspace manifest, exact versions, ordered exports, bins, lock digest and current
FMS profile/standard digests. It is checkpoint evidence, not a second live catalog.

All six publishable packages are development tooling; `public-development`
describes exposure and intended installation, not a private API. Foundation must
never enter consumer production runtime dependencies. The private repository
root and private parser spike have no declared exports or bins and are classified
`private-only` for this checkpoint; private flags alone cannot establish that
classification for future packages. Qualification subpaths are public too.

| Package under `@agent-teams/` | Version | Typed export paths |
| --- | --- | --- |
| engineering-foundation | 1.3.3 | `.`, `./local-mode`, `./scaffolding`, `./scaffolding/qualification` |
| repository-mutation | 0.2.0 | `.`, `./serialization`, `./paths`, `./coordination`, `./known-file`, `./node`, `./qualification` |
| document-authoring | 0.3.0 | `.`, `./observation`, `./qualification` |
| docs-protocol | 0.6.0 | `.`, `./qualification` |
| docs-protocol-agent-teams | 0.2.8 | `.`, `./qualification` |
| docs-protocol-mcp | 0.2.3 | `.` |

Every typed entry uses ordered `types` then `import` targets. All six expose
`./package.json`; all except MCP expose `./schemas/*`; Foundation also exposes
`./presets/*`. Exact targets and five bin names are in the inventory. Package
archives were not supplied: manifest coverage is not exact packed qualification.
The [finite observer matrix](sdk-growth-c0/surface-matrix.json) retains manifest
observations at exact EF/GM/AR bases as cross-repository test evidence, not consumer
policy or a live catalog. GM/AR still own their classifications and activation;
no XF adoption claim is made. Unsupported shapes remain incomplete and do not
justify a language-wide analyzer.

The active FMS profile remains `architecture/foundation/feature-modules.json`,
standard v1, digest `sha256:851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa`.
EF's existing capability uses Pure DI; no GM composition migration or new CMS pin
is required. SDK growth activation is pending, independently of active v1 checks.

## Reconciliation identity

The organization Engineering Quality Standard was read from the supplied excluded
input at commit `4e8626382bb04ef14c4cf47ae419ca05e1574ea6`, SHA-256
`8346f1a448f2c1afc0ee7b0aded338d1894f893c763836a17b79422515077d8b`.
Its full bytes establish the applicable ownership, evidence, compatibility and
proportional-testing rules. The previous missing-standard prerequisite is closed;
this review does not certify existing production conformance. The input is not
part of this patch and must not be committed.

The remediation instruction selects canonical plan SHA-256
`e025978dcf3cfac12b7795fa3aafc96f06838620e124df4cc091ebee45352864`.
The synced excluded input `.codex-inputs/sdk-and-owned-lifetime-implementation-plan.md`
now matches that exact SHA-256; its full text was reviewed. Canonical-plan
reconciliation is complete. This freeze covers EF C0 only; the plan’s later
implementation and activation gates are not C0 completion claims.
AR manifest evidence is reobserved from
`be96f01ea54ec7d2ec0156774e3dfb75fac46803`, replacing the stale AR attribution.
S1–S3 implementation and GM/AR activation remain separate prerequisites;
K1's first surface must pass activated G1 before merge. Excluded plan and
organization-standard inputs are not part of this patch.

[Contract identity](sdk-growth-c0/contract-identity.json) binds `contractRevision`
with the exact source base and selected plan hash, and binds the canonical UTF-8/LF bytes of this document, the EF inventory and the
finite matrix. Each file digest excludes the identity sidecar itself. These are
byte digests, not JSON key-sorted digests: manifest condition order is significant.
The sidecar is checkpoint identity, not approval or release evidence.

Permitted consumers of these three frozen artifacts are EF S1 observation,
S2 admission and S3 trust/qualification writers and reviewers, GM G1 and AR A3
SDK adoption writers and reviewers, and the coordinating C0 digest index. K1
may reference them for first-surface admission after G1. They do not authorize
production imports, ownership/lifecycle implementation or consumer activation;
the named consumer repository artifacts retain their own authority.

## Existing observer coverage

Owner: `public-api-compatibility/application/policies/validate-package-export-coverage.ts`
under `packages/engineering-foundation/src/capabilities/`. Its existing export
coverage tests are `tests/public-api-export-coverage.test.mjs`; artifact tests
are `packages/engineering-foundation/tests/public-api-artifact-inventory.test.mjs`.

| Actual accepted shape | Current evidence and limit |
| --- | --- |
| Closed subpath map, one concrete `types` target and ESM `import` | Typed paths checked independently against declarations; condition identity/order is lost |
| Root string, array or conditional object; root `types`/`typings` fallback | Accepted by normalization where target constraints hold; not full resolution semantics |
| Concrete data/runtime export | Path and kind coverage; runtime symbol census and bin admission are not proved |
| Untyped wildcard string | Concrete artifact inventory; schema byte/ID drift and member additions/removals |
| Wildcard arrays/conditions | Only identical unconditional targets; condition objects need `default`; null/unequal/conditional availability rejected |
| Typed wildcard or multiple distinct declaration targets | Rejected; explicit concrete entrypoints required |
| No exports map, empty map, mixed subpath/condition keys, null-only target | Rejected; no deep-import coverage claim |

Non-wildcard string/type target collection can discard null and ordering; its
acceptance must not be advertised as branch coverage. Dynamic CJS, arbitrary JS
runtime exports, missing packed entries and unresolved rich graph edges remain
unsupported for the future full-SDK claim. The bounded audit retains hidden
reachable types only within its documented compiler/reference limits and always
has `releaseEligible:false`. No audit projection becomes release authority.
The artifact inventory inspects wildcard members and their JSON Schemas; it
does not compare standalone `./package.json` or runtime-only export contents.

## Decision and CI authority

`AcceptedDecisionEvidencePort` is owned by this capability. Its current
`GovernanceAcceptedDecisionEvidenceAcl` outbound governance adapter delegates to
`readAcceptedArchitectureDecisionEvidence`; governance validates catalog,
lifecycle, immutable ADR digest and baseline. The port exposes only accepted IDs
and paths. Inputs are `architecture/foundation/governance-architecture-decisions.yaml`
and `architecture/decisions/accepted-decisions.json`; approved breaking fingerprints
come from `architecture/foundation/public-api-compatibility.yaml`.
ADR-0004 names the Product owner. This proves validated decision metadata, not
authenticated owner identity or human approval of a proposed growth transition.
S2 must extend that existing adapter for exact `ownerRef` and source/diff evidence;
it must not treat a generated admission JSON file as approval. `solo_owner` is
permitted when the existing consumer workflow proves that authority.

At the integration base, `.github/workflows/ci.yml` job `linux-static` runs
`pnpm foundation:check:built` and `pnpm release-owned-files:check`. Aggregate job
`check` requires all Linux lanes via the pinned all-green action. Documented
required contexts are `check`, `windows-check`, `macos-qualification`, `CodeQL`
and `analyze`; CodeQL belongs to `.github/workflows/codeql.yml`. Release attestation
in `.github/workflows/release.yml` has its separate exact-head status procedure.
Fresh read-only GitHub evidence delivered by the orchestrator on 2026-09-14
(control signal `c9b46ea1-bc0b-45ae-bdd3-05e2912706c6`, 19:24:55 UTC) reports
active repository rulesets EF `19979782`, GM `21807869` and AR `19979781`.
They require only status-check contexts produced by GitHub Actions integration
`15368`. PR branches can change their workflow bytes, so these active rulesets
do not prove an immutable workflow anchor. Organization ruleset/required-workflow
discovery returned HTTP 403, `Upgrade to GitHub Team to enable this feature`.
Observed current-main check-runs show no external SDK verifier app. This is
attributed supplied GitHub evidence, not an independent live query by this worker;
the 403 does not prove that every possible external authority is absent.

During the predecessor refresh, independent `gh api` queries for EF ruleset `19979782`
and organization rulesets could not authenticate: the runtime requires
`GH_TOKEN` and has no usable GitHub CLI authentication. No live ruleset or
check-run response was obtained. The earlier HTTP 403 remains supplied historical
evidence, not the result of these attempts. Direct retrieval of the current
organization standard was also denied by the network allowlist; the retained
standard and canonical plan were reread during that predecessor refresh from
the source checkout's excluded inputs and their recorded hashes independently
matched. In revision 4 the canonical plan and freeze audit are available as read-only
excluded inputs; the plan hash was independently matched. Direct standard
retrieval was again denied by the network allowlist. A retained copy in the AR C0 evidence workspace was subsequently read in full
and independently matched the recorded standard SHA-256 above; this is retained
revision evidence, not current upstream freshness. No current remote-main,
external verifier or organization required-workflow discovery claim is made.

`scripts/check-release-owned-files.mjs` compares `origin/${GITHUB_BASE_REF}...HEAD`,
protects changes under `architecture/contracts/` and `architecture/public-api/`,
allows additions/copies, and exempts the same-repository `changeset-release/main`
branch. It separately retains accepted ADR history. Candidate-selected scripts,
mutable base refs and same-name checks do not prove immutable verifier authority.

**S3/G1/A3 trusted activation: blocked.** No supported non-candidate authority
is established by repository evidence or the supplied GitHub observation.
An active ruleset and a successful same-name Actions check cannot close this gate.
The repository/org owner must supply a supported ruleset or
externally controlled required workflow identity and immutable ref, trusted EF
artifact SHA/integrity, target/base source, owner-evidence binding and run/artifact
custody. No such anchor is established; no ref is invented and C0 designs no new service.
The trusted entrypoint must call the pinned checker directly, verify consumer
command/scope/report, and inspect the current merge result. Candidate builds run
without write/release credentials in separate disposable directories and cannot
write verifier inputs or verdicts. Never execute candidate code with privileged
`pull_request_target`. A hash proves identity, not provenance. Removing or replacing
the candidate command, checker or workflow must fail a trusted integration fixture.

The finite matrix is the C0 coverage boundary: each package has its exact
manifest digest, exports/bin shape and observer status. `limited` describes an
existing bounded observer, never full growth support. `unsupported` records an
actual shape outside that observer; `unavailable` records missing qualification.
Packages without declared exports are not silently private-only: source/main/bin
exposure needs consumer classification, and the existing exports-map observer
cannot establish their full surface. No complete SDK claim follows from C0.

## Frozen pseudo-contract revision 5

All records below are closed, readonly data. `Digest` means lowercase
`sha256:` plus 64 hex digits; `Commit` is exactly 40 lowercase hexadecimal characters; paths are normalized
repository-relative paths. Unknown versions/fields are rejected. This vocabulary
is separate from v1 configuration, stored snapshots and promotion fingerprints.
S1–S3 must implement it through existing ports and command composition, with
explicit profile migration; installation alone does not activate growth policy.
The consumer entrypoint remains
`agent-teams-foundation check package.public-api-compatibility`; audit and
`public-api-promote-release` keep their separate existing claims.

```ts
type Digest = `sha256:${string}`;
type Commit = string;
type ResolutionStep = { condition: string } | { index: number };
type ResolutionTree =
  | { kind: "target"; target: string }
  | { kind: "null" }
  | { kind: "conditions"; entries: { condition: string; value: ResolutionTree }[] }
  | { kind: "fallbacks"; entries: ResolutionTree[] };
type Coordinate = {
  packageName: string;
  exportPath: string; // package/bin use "."; wildcard uses concrete public path
  resolutionBranch: ResolutionStep[];
  subject:
    | { kind: "typed"; canonicalReference: string }
    | { kind: "export-branch" }
    | { kind: "bin"; name: string }
    | { kind: "data" | "wildcard-member"; member: string }
    | { kind: "package" };
};
type ValueRef = { state: "absent" } | { state: "present"; digest: Digest };
type Transition = {
  coordinate: Coordinate; before: ValueRef; after: ValueRef;
  policyVersion: "foundation:sdk-growth:policy:1";
  fingerprint: Digest;
};
type EvidenceRef = {
  useCase: string; repository: string;
  source: { tree: string; contentDigest: Digest; commit: Commit | null };
  artifactDigest: Digest | null;
};
type Decision = {
  contractRevision: "foundation:sdk-growth:c0:5";
  decisionId: string; ownerRef: string;
  stability: "development" | "experimental" | "supported";
  transitions: Digest[]; coordinates: Coordinate[]; changeFingerprint: Digest;
  consumerEvidenceRefs: EvidenceRef[]; exposureRationale: string;
  compatibilityRationale: string;
  lifecycle: { kind: "ordinary" } | {
    kind: "shim" | "deprecation" | "removal";
    replacement: string; migration: string; removalConditions: string;
  };
};
type Coverage = {
  packageName: string;
  classification: "governed" | "private-only";
  dimensions: {
    dimension: "topology" | "resolution" | "typed" | "reachable" | "runtime"
      | "bin" | "data" | "wildcard" | "packed" | "decision";
    status: "complete" | "limited" | "unsupported" | "unavailable";
    reasons: string[];
  }[];
};
type GrowthSurfaceObservation = {
  contractRevision: "foundation:sdk-growth:c0:5";
  observationVersion: "foundation:sdk-growth:observation:1";
  repository: string;
  sourceCommit: Commit; sourceTree: string;
  topologyDigest: Digest; lockDigest: Digest; toolchainDigest: Digest;
  artifactDigests: Digest[];
  tool: { version: string; artifactDigest: Digest; extractorVersion: string };
  coverage: Coverage[];
  entries: { coordinate: Coordinate; value: ValueRef }[];
};
type ObservationRef = {
  sourceCommit: Commit; sourceTree: string; surfaceDigest: Digest;
  topologyDigest: Digest; lockDigest: Digest; toolchainDigest: Digest;
  artifactDigests: Digest[];
};
type Observation = { status: "available"; value: ObservationRef }
  | { status: "unavailable"; reasons: string[] };
type Comparison =
  | { status: "complete"; before: Digest; after: Digest; transitions: Transition[] }
  | { status: "incomplete"; reasons: string[]; findings: Transition[] };
type RepositoryPath = string;
type V1Package = {
  packageName: string; packageRoot: RepositoryPath; manifestPath: RepositoryPath;
  entrypoints: { exportPath: string; declarationEntryPoint: RepositoryPath }[];
  nonTypeExports: { exportPath: string; kind: "data" | "runtime" | "wildcard" }[];
  tsconfigPath: RepositoryPath; releasedBaselinePath: RepositoryPath;
  approvedBreakingChanges: { fingerprint: Digest; decisionId: string }[];
};
type GrowthComparisonInputs = {
  trustedBasePath: RepositoryPath;
  released: ({ packageName: string } & (
    { kind: "released"; observationPath: RepositoryPath }
    | { kind: "initial-unreleased"; trustedHistoryPath: RepositoryPath }
  ))[];
};
type SdkGrowthConfig = {
  contractRevision: "foundation:sdk-growth:c0:5";
  policyVersion: "foundation:sdk-growth:policy:1";
  comparison: GrowthComparisonInputs;
  decisionsPath: RepositoryPath;
  reportPath: RepositoryPath;
};
type CompatibilityV2 = {
  schemaVersion: 2;
  acceptedDecisionBaselinePath: RepositoryPath;
  changesetDirectory: RepositoryPath;
  governanceConfigPath: RepositoryPath;
  packages: V1Package[];
  sdkGrowth: SdkGrowthConfig;
};
type Evidence<T> = { status: "available"; value: T }
  | { status: "unavailable"; reasons: string[] };
type ReleasedEvidence<T> = { packageName: string; evidence:
  { kind: "released"; observation: Evidence<T> }
  | { kind: "initial-unreleased"; history: Evidence<Digest> }
};
type GrowthInvocation = {
  repository: string; sourceCommit: Commit; sourceTree: string;
  topologyDigest: Digest; lockDigest: Digest; toolchainDigest: Digest;
  artifactDigests: Digest[];
  tool: { version: string; artifactDigest: Digest; extractorVersion: string };
};
interface Cancellation { throwIfCancelled(): void; }
type V1CompatibilitySnapshot = {
  schemaVersion: 1; packageName: string; packageVersion: string;
  extractorVersion: string;
  entrypoints: { exportPath: string; items: {
    canonicalReference: string; kind: string; parentReference?: string;
    parentKind: string; signature: string;
  }[] }[];
};
type V1CompatibilityPackage = {
  readonly packageName: string;
  readonly typed: { readonly kind: "typed"; readonly snapshot: Evidence<V1CompatibilitySnapshot> };
  readonly artifact: { readonly kind: "artifact"; readonly snapshot: Evidence<V1CompatibilitySnapshot> };
};
type GrowthObservationExecution = {
  readonly identity: GrowthInvocation;
  readonly surface: Evidence<GrowthSurfaceObservation>;
  readonly compatibilitySnapshots: readonly V1CompatibilityPackage[];
};
interface GrowthObservationPort {
  observe(invocation: GrowthInvocation, cancellation: Cancellation):
    Promise<GrowthObservationExecution>;
}
type GrowthContextRequest = {
  trustedBasePath: RepositoryPath;
  released: GrowthComparisonInputs["released"];
  decisionsPath: RepositoryPath;
};
type GrowthInputContext = {
  trustedBase: Evidence<GrowthSurfaceObservation>;
  released: ReleasedEvidence<GrowthSurfaceObservation>[];
  decisions: Decision[];
  authority: Report["authority"];
};
interface GrowthInputContextPort {
  read(request: GrowthContextRequest, cancellation: Cancellation): Promise<GrowthInputContext>;
}
type ReportPublicationFailure = {
  kind: "report-conflict" | "report-io-failure" | "report-publication-uncertain";
  reason: string;
};
interface GrowthReportWriterPort {
  write(destination: RepositoryPath, report: Report, cancellation: Cancellation):
    Promise<{ status: "finalized"; digest: Digest; disposition: "published" | "replayed" }
      | { status: "failed"; failure: ReportPublicationFailure }>;
}
type Report = {
  contractRevision: "foundation:sdk-growth:c0:5";
  policyVersion: "foundation:sdk-growth:policy:1";
  repository: string; trustedBase: Observation; candidate: Observation;
  released: ReleasedEvidence<ObservationRef>[];
  tool: { version: string; artifactDigest: Digest; extractorVersion: string };
  authority: { status: "verified"; workflowRef: string; runRef: string; receiptDigest: Digest }
    | { status: "unverified"; reasons: string[] };
  coverage: Coverage[]; trustedBaseComparison: Comparison;
  releasedComparison: Comparison;
  transitionReceipts: { before: Digest; after: Digest; decisions: Digest[];
    transitions: Digest[]; trustedRunRef: string }[];
  phases: { name: string; status: "complete" | "failed" | "unavailable" }[];
  verdict: "admitted" | "rejected" | "incomplete";
  releaseEligible: boolean;
};
```

Indices are nonnegative integers. Conditions and fallback arrays retain order,
including null leaves. A condition
step identifies its key, not its target or sibling ordinal; array steps identify
indices. The ordered tree is the export-branch observed value, so reordering
conditions changes its digest even when typed symbols are identical. Canonical
references remain opaque; signatures, kind, overloads, target and availability
are values, never identity. The same symbol on two paths has two coordinates.
Absent differs from a present null branch. Whole-package classification/removal
uses the package coordinate; internal packed JS byte changes affect artifact
identity without manufacturing SDK additions.

Hash canonical JSON using the existing canonical JSON primitive: object keys
ordinally sorted, arrays retained. Atomic payload is exactly
`{domain:"foundation:sdk-growth:transition:1",policyVersion,coordinate,before,after}`.
Group payload is `{domain:"foundation:sdk-growth:group:1",policyVersion,transitions}`,
where transitions are unique atomic fingerprints sorted ordinally. Neither
payload contains admission bytes, final commit SHA or its own fingerprint.
Decision coordinates must equal the bounded transition coordinate set; evidence
and rationale are nonempty. Duplicate or no-change transitions are invalid.
Candidate evidence may bind content/tree before commit; the final report verifies
the commit/tree binding. Released evidence requires immutable source/artifact
identity. Stable supported APIs receive no invented removal date.

Unavailable observations and unverified authority carry nonempty reasons and
force an incomplete verdict; they cannot be replaced by empty successful input.
Released evidence is per package so existing and initial-unreleased packages can
coexist. Comparisons bind the digest of their entire admitted observation set.
Normative phases order is topology, observation, packed, decision, trusted-base,
released, authority; each appears exactly once in this order, even when unavailable. Admission requires all phases and
dimensions complete, verified authority and both complete comparisons. A release
eligibility claim additionally requires the existing release policy to pass.
Existing bounded audit limits remain: separate current and historical budgets of
4,096 files and 32 MiB, plus its observation/serialization limits. Limits do not
permit truncated equality or empty success.

Coverage contains the union of trusted-base and candidate topology, including
renames, removed directories, workspace-glob changes and public development
surfaces in private packages. Every dimension appears exactly once per package;
a non-applicable dimension is complete with an explicit applicability reason.
Missing observation is never equality. Missing/shallow base, lost archives,
extractor mismatch, budget exhaustion, unresolved references or scope drift
prevent admission. Incomplete reports may retain scoped findings but have
`releaseEligible:false`, verdict `incomplete`, and exit 2. Rejected complete
reports exit 1; admitted complete reports exit 0. These are future growth-mode
codes, not a change to current audit/check exits. Malformed requests exit nonzero
without fabricating an observation. Audit reports always remain release-ineligible.

Trusted-base→candidate admits this PR's atomic transitions. Released→candidate
independently applies the existing direct comparator, SemVer, exact breaking
approval and removal obligations. Growth receipts cannot waive those rules.
Retain trusted receipt chains through merged additions until release promotion:
`absent→A` followed by `A→B` requires two decisions and cannot authorize
`absent→B`. A trusted successful exact-target receipt can summarize prior history;
no new event store or whole-history replay is required. Gaps are incomplete.
Add→remove before release preserves admission history without inventing a
published obligation. Reverts are reverse transitions. Rebases with changed
surface require new fingerprints; squash/merge receipts bind resulting tree and
surface with commit separately. Recheck the actual current merge result.

Historical v1 evidence without new dimensions is limited, not regenerated in
place. Qualified bootstrap observes exact released archives. `initial-unreleased`
requires trusted catalog/history proof of no prior release, an empty released
surface and full first-surface admission. Candidate flags, rename, 404/5xx or lost
access cannot select it. The old name's removal obligations survive renaming.
Current v1 0.0.0 baseline bootstrap remains its separate existing rule.

## Revision 5 bounded execution closure

### Feasibility at the exact start HEAD

Read before this freeze: the retained compatibility v1 schema, capability
`adapters/inbound/configuration/load-capability-config.ts` and
`parse-capability-config.ts`, `module.ts`, `schemas.ts`, governance ACL, and
`features/validation-reporting/application/model.ts` and `reporting.ts` under
`packages/engineering-foundation/src/`. The v1 root is closed and requires
schemaVersion 1; the header currently rejects other versions, the loader selects
v1 literally, and the mapper returns schemaVersion 1. Adding sdkGrowth to v1
would break its claimed contract. The feasible S2 route is one discriminating
header, exact schema selection, one shared unchanged-field mapper, then the
version-specific growth input mapping. Preserve the entire v1 branch, including
validation ordering, stable baseline anchors, governance requirements, errors,
defaults, audit and promotion behavior. No second policy/parser implementation.
V2 is selected only for the existing check; it does not authorize growth-mode
promotion or change the audit request route.

CapabilityReport already accepts explicit outcome, problem and diagnostic
kind/value evidence. Its default treats any diagnostics as violations, including
info; S2 must pass the explicit mapped outcome. FoundationCheckReport stays v1.
The existing composition injects filesystem, fingerprint, extractor and governance
ports with Pure DI; growth belongs inside this capability. No contradiction
preventing the dual-version route was found. This is feasibility evidence, not
implemented compatibility. If exact S2 code/fixtures disprove v1 preservation,
S2 becomes compatibility-blocked with the precise failing fixture; S1 remains
conditionally go. Never mutate v1 or invent another command to bypass that finding.

### One S1 observation and one input boundary

S1 exposes only the internal GrowthObservationExecution above: no public CLI,
config selector, schema export or production report sink changes. It uses the
existing observers and fingerprint port. S2 consumes the retained aggregate and
its projection; ObservationRef is a reference, never a substitute for entries.
Its surfaceDigest is SHA-256 of canonical structured input
`{domain:"foundation:sdk-growth:observation:1",payload:GrowthSurfaceObservation}`,
serialized as canonical JSON UTF-8 without trailing newline. It is not a digest
of arbitrary input file bytes. Neither payload nor digest input contains
surfaceDigest or any other self-reference. Reference identities must equal the
aggregate identities; resolve the full aggregate and verify the digest before diff.

Canonical JSON sorts object keys ordinally and retains array order. Normalize
set-like arrays first: artifactDigests and reasons unique ordinally sorted,
coverage sorted by packageName, dimensions sorted by dimension, entries sorted
by canonical JSON of the full coordinate (ordinal comparison). Reject duplicate
coordinates before sorting, including conflicting values. Resolution branches,
condition order and fallback order retain their semantic order. Every topology
package has complete Coverage structure with all ten dimensions exactly once;
complete structure does not imply complete evidence. Every supported coordinate
in the bounded observation must have exactly one entry; coverage cannot certify
missing entries. Every matrix row is observed once or explicitly unsupported.
Unsupported/unavailable rows retain coverage reasons; they never synthesize absent.
Absence requires topology and observer proof, including comparison-side coordinates
for additions/removals. Source tree is a 40-hex Git tree identity; tool strings
are nonempty. S1 decision dimension records unavailable until S2 supplies evidence;
S2 derives Report coverage without rewriting the immutable S1 payload.

GrowthInputContextPort is the single application-owned input/context boundary.
Its candidate filesystem adapter loads comparison files and the one
Decision source, validates bytes and identities, and always yields authority
unverified. Embedded verified authority is rejected, not promoted by a path named
trustedBasePath or trustedHistoryPath. Future S3 can inject independently verified
context through this same port without changing observation/admission policy.
Policy types and ports point inward; filesystem/config/report adapters point
outward. No second census, comparator, CLI or general platform report framework.

The S2 application use case invokes GrowthObservationPort exactly once in the
same run with explicit GrowthInvocation and Cancellation arguments. It verifies
all returned repository/source/build/artifact/tool identities against that
invocation before comparison or projection. Mismatch is a typed invariant
failure (failed/3), never missing evidence or admission. The same cancellation
flows through observation, context loading and publication. The invocation is
assembled at the command boundary from the actual source/build/artifact inputs;
it is not loaded from sdkGrowth or captured as hidden adapter configuration.
GrowthInputContextPort loads trusted-base/released-history/decision evidence and
authority context only; it cannot supply a candidate. S2 derives ObservationRef
once from the S1 aggregate using the one shared projection; no second observer
or projection is permitted. Observation/admission policy owns orchestration;
filesystem adapters load/store and translate I/O only. The context request is
explicit policy-owned data, not a Node/config object. The report writer is a
separate narrow policy-owned port; it does not observe, admit or activate authority.

ReleasedEvidence preserves its kind in context and report even when evidence is
unavailable. Missing initial-unreleased history retains that branch with nonempty
reasons and yields incomplete; never invent a digest or switch to released.
Available initial history must validate trusted no-prior-release proof before an
empty released surface can be derived. Context-to-report projection maps available
released aggregates to ObservationRef and retains unavailable reasons and history
unchanged. Candidate claims cannot establish the initial branch's authority.

The single S1 execution returns GrowthObservationExecution: explicit invocation
identity, the growth surface and retained v1 compatibility snapshots from that
same execution. S2 validates the envelope identity and surface identities against
GrowthInvocation before using either result; a mismatch is the typed invariant
failure (failed/3) above. Snapshots are bound to that same repository, source,
build, artifact and tool identity, never loaded as candidate context evidence.
The existing PublicApiSnapshot fields are retained losslessly: schemaVersion,
packageName, packageVersion, extractorVersion, exportPath and each item's
canonicalReference, kind, parentKind, optional parentReference and signature.
Preserve absent parentReference versus an empty string and exact signature bytes.
The unchanged classifyPublicApiChange comparator receives each branch separately,
using the existing ChangeFingerprint port. Each unique per-package handoff row
requires both explicitly tagged typed and artifact Evidence branches. Typed routes
to the unchanged releasedBaselinePath flow; artifact routes to the existing
artifact baseline/projection flow through artifactApiProjection of
PublicApiArtifactSnapshot, retaining extractorVersion package-artifact-inventory/1.
Retain distinct typed and artifact baseline bytes, evidence and v1 fingerprint
inputs, including existing empty-wildcard and missing-baseline behavior. The one
high-level GrowthObservationPort invocation may invoke each existing low-level
typed and artifact observer once per package; no second S1 census or growth
projection, new comparator or change to v1 behavior is permitted.
Retain its existing v1 added/changed/removed item evidence, before/after values,
serialization and fingerprint semantics; growth ValueRef digests cannot replace
that evidence or become v1 fingerprints. This is a retained result of the one
high-level observation execution, not a second extraction or projection from
growth digests. Unavailable snapshots retain reasons and yield incomplete; they
must not be fabricated from surface entries. Growth admission and release
compatibility remain separate policies, coordinated by the application use case.
The compatibility handoff is an internal deeply readonly result bound by the
explicit GrowthInvocation envelope, not persisted evidence. Do not add an
execution-envelope digest. The compatibility handoff is not included in growth
hash payloads; growth surface digest and existing v1 fingerprints remain separate
domains. V1 snapshot ordering and fingerprint inputs remain unchanged.
Handoff rows are unique by packageName and match the invocation's observed package
set exactly. Every available snapshot packageName must equal its row packageName;
validate each tag and observer provenance before dispatch to its matching route.
Omission, duplicate rows, cross-branch substitution or conflation fails closed as
a typed invariant failure (failed/3). Both branch fields are mandatory even when
unavailable: retain each branch's nonempty reasons and yield incomplete, never
substitute the other branch or fabricate evidence from growth surface entries.

### Canonical collection rules

Before every observation, comparison, group, decision or report hash, reject
duplicate keys in every set-like collection (including identical duplicates),
then sort by the keys below using existing compareBinaryStrings semantics:
raw UTF-16 code-unit order for all scalar sort keys and canonical JSON strings
after serialization, with no locale or normalization. Object keys use the same
comparator. UTF-8 encoding occurs only after canonicalization for hashing bytes.
No deduplication, locale sorting or input-order tie breakers are allowed.
Invalid duplicates are invalid input, never silently merged or truncated.

| Set-like collection (at every nesting level) | Unique key and ascending sort key |
| --- | --- |
| artifactDigests; transitions containing Digest; receipt decisions | Digest |
| reasons | reason string |
| coverage; released rows in config/context/report; packages | packageName |
| coverage dimensions | dimension |
| observation entries; Decision coordinates | canonical JSON of full coordinate |
| Comparison transitions and findings | canonical JSON of full coordinate |
| Decision records | decisionId |
| consumerEvidenceRefs | canonical JSON of complete EvidenceRef |
| transitionReceipts | canonical JSON of [before, after] |
| entrypoints; nonTypeExports | exportPath |
| approvedBreakingChanges | fingerprint |

Comparison rows also reject duplicate fingerprints and no-change transitions.
Receipt transitions and decisions reject repeated digests; decision transitions
must match their unique coordinate set. Distinct records with the same key are
conflicts, not tie-break candidates. EvidenceRef artifactDigest is scalar;
all artifact reference arrays follow artifactDigests ordering. This normalization
applies recursively before hashing containers, including report released rows,
comparison findings, decisions, receipt refs, coverage, entries and reasons.
Conditions, fallbacks and resolutionBranch are semantic sequences: retain their
order and nulls, never set-sort them. Condition keys must be unique within each
condition object; fallback entries may repeat because their positions matter.
Phases use only the normative phases order above; duplicate/unknown/missing
phases are invalid. These growth normalization rules do not reorder v1 inputs
or change retained v1 mapper or validation behavior.

### One closed v2 route and decision source

S2 owns the new artifact
`packages/engineering-foundation/schemas/package-public-api-compatibility/v2.schema.json`,
with $id `https://schemas.agent-teams.ai/engineering-foundation/package-public-api-compatibility/v2`.
The existing capability ID and command remain
`package.public-api-compatibility` and
`agent-teams-foundation check package.public-api-compatibility`.
CompatibilityV2 above is closed at every object/union branch; every shown field
is required. V1Package is a normative reference to the exact retained v1
$defs/package, not permission for arbitrary keys. All its nested required fields,
closed objects, enums, patterns and mapper constraints remain unchanged. V2 root
retains v1 path rules and package bounds (1..100 packages, 1..100 entrypoints,
0..100 nonTypeExports and approvedBreakingChanges). governanceConfigPath is
required for v2 decision validation. acceptedDecisionBaselinePath remains exactly
`architecture/decisions/accepted-decisions.json`. No enabled flag or implicit mode.

sdkGrowth permits exactly contractRevision, policyVersion, comparison,
decisionsPath and reportPath. comparison permits exactly trustedBasePath and
released only. released has 1..100 unique package rows, exactly
covering governed topology; its tagged branches forbid each other's path fields.
All new paths are normalized repository-relative regular-file paths, 1..300
characters, with no absolute/drive path, empty/dot/parent segments, backslash,
NUL, glob or symlink traversal. Package names obey the v1 1..214 pattern.
Read each JSON input with duplicate-key rejection. Each comparison aggregate
and the decisions file is bounded to 32 MiB; observation entries and total
Decision transitions each have a 100,000 item ceiling. Decisions are a closed
JSON array of 0..10,000 Decision records; nonempty strings are limited to 4,096
characters, except paths/package names with tighter limits. Existing bounded
audit budgets (4,096 files and 32 MiB per side) also remain. Exceeding any bound
is incomplete, never truncation. No extra selector or tuning keys are permitted.

The sole declarative Decision source is decisionsPath. Its records are the
closed Decision type above, with exact unique transitions/coordinates and no
wildcards. GovernanceAcceptedDecisionEvidenceAcl validates accepted decision,
ownerRef, source/evidence binding and exact transition set through existing
governance authority. Extend that ACL's evidence contract in S2; current accepted
IDs/paths alone are insufficient. Candidate/config bytes alone prove no approval.
Each transition belongs to exactly one decision; missing, extra, overlapping or
partial sets reject semantic admission. Missing authority/evidence instead keeps
the overall result incomplete. S2 reads only: it never updates decision evidence,
accepted baselines, trusted observations or promotion state.

The v2 artifact requires its own release-owned baseline and
`contract.json-schema-releases` corpus plus consumer evidence in S2. Its concrete
new `./schemas/*` wildcard member is covered by the exact S2 growth decision,
including its absent-to-present transition. It is not legacy surface, not a
mutation of claimed v1, and must not be added during S1. No release evidence or
approval is fabricated by this documentation freeze.

### Atomic artifact, outcomes and S2 qualification

Report is one separate atomic JSON artifact at reportPath. It never adds fields
to FoundationCheckReport v1. The report path must be distinct from every input,
baseline and decision path, contained in the consumer root through checked real
parents, and outside governed source/package trees. Reject symlinks and non-regular
files at the destination and every traversed component (parents must be real
directories). Fix the validated destination for the entire invocation.
The one report writer acquires an exclusive report-slot lock/fence before reading
and capturing the preimage: either absent or exact bytes plus file identity.
Competing writers fail immediately with report-conflict; never steal a live lock
or blindly retry. All writers of this slot must honor the same fence. An adapter
unable to prove exclusivity against its supported writers fails closed.
Same canonical bytes at the validated fixed destination are an idempotent replay:
revalidate containment, regular-file identity, bytes and fence before finalized.
Changed bytes require a unique exclusively created sibling temporary regular file,
serialize the complete Report, flush and close, then revalidate the captured
preimage and containment under the fence immediately before atomic replace.
An absent preimage uses atomic no-replace publication under the same fence.
A stale preimage or lost fence is report-conflict, never success or blind retry.
The fence covers preimage capture through publication and final destination byte
verification. It must remain held without expiry/reclamation during replacement;
a check of an expiring token alone cannot fence an atomic filesystem rename.
Unsupported atomic replacement/fencing is report-io-failure, with no unsafe
check-then-rename fallback. Unknown post-publication result is
report-publication-uncertain, never success or blind retry. These typed failures
map to failed/3 and expose no Node filesystem errors to policy. Cleanup releases
only owned temp/lock resources and preserves primary failure/cancellation.
Cancellation before the final preimage/fence check yields cancelled/130 without
any destination change. Check cancellation immediately before entering the bounded
atomic publication section, which starts with that final preimage/fence check.
Once entered, defer cancellation checks through final destination-byte verification;
return finalized or publication-uncertain failed/3, never cancelled after bytes may
have published. A known pre-publication fence/preimage failure still returns its
typed conflict/failed/3. Idempotent replay uses the same cancellation boundary
around final identity/byte/fence verification. The caller must consume the writer's
finalized result without a late cancellation check reclassifying this publication.
This is one fixed report-slot mechanism, not a general transaction framework.
Only after successful finalization may capability diagnostics link the artifact.
Report digest is SHA-256 of exact published UTF-8 canonical JSON bytes plus one
LF, and is outside Report (no self-reference). The diagnostic uses ruleId
`package.public-api-compatibility.sdk-growth-report`, subject repository,
location.path reportPath, and evidence kinds `sdk-growth-report-path`,
`sdk-growth-report-digest`, `sdk-growth-contract-revision` with exact values.
It uses info severity and requiresArchitectureReview false; ordinary diagnostic
fields remain mandatory. Rejected/incomplete artifacts are diagnostics, not
successful qualification receipts.

Validate the entire transition set before creating transitionReceipts. Rejected
or incomplete Report has transitionReceipts empty and releaseEligible false.
No partial receipt is ever emitted. A computed admitted result is not a saved
success: any write/flush/close/publication failure suppresses success diagnostics
and receipts and returns failed/3. Temporary cleanup must not replace the primary
error. If publication completed but acknowledgement became uncertain, do not
claim success or retry overwrite: expose failed/3 and the uncertainty. A retained
file alone cannot qualify without the successful finalization diagnostic and
exact digest linkage. No separate receipt writer is introduced.

| Condition | FoundationOutcome | Exit | Problem / receipt |
| --- | --- | --- | --- |
| Complete, verified, admitted, finalized; compatibility passes | passed | 0 | Whole-set receipt only |
| Complete, verified evidence; rejected admission or compatibility violation | violations | 1 | No successful receipt |
| Expected missing/untrusted/incomplete evidence (even with semantic findings) | invalid-input | 2 | SDK_GROWTH_EVIDENCE_INCOMPLETE; no receipt |
| Unexpected adapter/programming/invariant/report-write failure | failed | 3 | Preserve original classified failure; no receipt |
| Explicit cancellation before atomic publication section | cancelled | 130 | EXECUTION_CANCELLED; no receipt |

Incomplete problems use phase `sdk-growth-evidence`, retryable false and a
nonempty bounded reason message. Malformed v2 configuration retains configuration
invalid-input classification; it is not manufactured missing evidence. Map only
expected typed evidence failures to SDK_GROWTH_EVIDENCE_INCOMPLETE. Never catch
invariant defects as incomplete. Finalization failure overrides a computed
verdict; an already raised primary failure/cancellation keeps its classification
if secondary cleanup fails. Existing aggregate precedence remains cancelled >
failed > invalid-input > violations > passed; no global outcome change.

Before S3, the public packed binary uses candidate-sourced context. Even an exact
semantically matched decision set produces Report verdict incomplete, authority
unverified, exit 2, releaseEligible false and no successful qualification receipt.
Missing/extra/overlapping decisions and mixed valid+invalid transitions retain
semantic findings without upgrading authority. S2 packed tests also cover
compatibility breaks and input-order determinism in disposable projects. A separate
application contract test may inject an explicit test-only verified port to cover
admitted/0 and complete whole-set receipts. This fixture is never retained as
trusted CI authority and is not a public config switch. Full S1/S2 exact-head
verification and S2 packed qualification remain future lane obligations.

## Verification ownership and pending prerequisites

C0's focused `tests/sdk-growth-c0-contract.test.mjs` checks the frozen inventory
identity, ordered manifest evidence, v1 schema preservation, pseudo-contract
syntax and existing command anchors. Independent fixed expectations reject stale
source/plan identities, omitted or substituted packages, inflated observer claims,
release eligibility, premature activation and self/hash drift even after an
artifact sidecar is refreshed. These are C0 artifact mutations, not an
implementation of the future report validator. Historical inventory was compared with the
exact integration-base manifests when captured; CI needs no historical Git fetch.
It proves documentation evidence, not future gate execution. No second parser,
comparator, no-op command, exported schema or runtime stub is introduced.

| Future rule / rejecting fixture | Owner |
| --- | --- |
| Type-only/member/hidden changes; equal-count replacement; repeated symbol paths | S1 existing Extractor/coverage adapters |
| Condition order/target/null/fallback; bins/runtime/data; concrete wildcard; packed mismatch | S1 existing observation/artifact adapters |
| Package/config/glob removal and classification shrink | S1 topology union and S3 integration |
| Missing/wrong decision; rebase; PR1 A then PR2 B; exact bounded groups | S2 policy and governance ACL |
| Lost base/archive, version mismatch, receipt gap, false initial-unreleased | S2/S3 evidence admission |
| Baseline+approval rewrite, command removed/no-op, candidate verifier write | S3 trusted workflow integration |

S1's existing observer fixtures must run against the pinned toolchain before any
expanded support claim. S3 must provide exact packed evidence and the immutable
CI anchor described above. Consumer activation/pins remain separately owned.
The supplied organization standard has been reviewed; no missing-standard
prerequisite remains. Canonical-plan reconciliation is complete. Immutable CI
authority remains blocked for S3/G1/A3; owner authentication and exact packed
qualification remain separate S1–S3 prerequisites.

S1/S2: go after C0 review/integration. S3/G1/A3: blocked (`external-authority`)
as described above. K1/A1/A2: blocked (`architecture-admission`); the retained AR
checkpoint proves only one materially distinct scope and no existing recovery
owner for unreturned Host debt. A successor architecture-admission C0 with new
production scope/recovery evidence is required to resume those lanes. No ownership,
lifecycle, runtime, CI activation or full-SDK implementation is claimed.
