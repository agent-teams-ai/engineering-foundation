# Public API Compatibility

Status: Accepted and implemented by ADR-0004. Consumer activation remains gated
on release-owned baseline mutation enforcement in that repository.

`package.public-api-compatibility` compares built declaration entry points with
a committed snapshot of the last released TypeScript API. The native TypeScript
adapter retains the Microsoft API model behind the existing outbound port; model
and compiler types do not cross into capability policy.

## Native TypeScript 7 adapter migration

The implementation uses exact `typescript@7.0.2`,
`@microsoft/api-extractor-model@7.33.10`, and `@microsoft/tsdoc@0.16.0`.
The executable API Extractor dependency and its embedded TypeScript 5.9.3 are
removed. The independent source parser oracle also uses TypeScript 7; its
retained historical corpus and explicit source-phase import divergence remain.
This is an adapter replacement under ADR-0004, with no new public port or schema.
TypeScript is now a required runtime dependency of the tooling package, so the
repository no longer classifies it as universally development-only. The existing
source profile admits production imports only in the public API adapter and its
pinned SDK loader. Other production boundaries retain their compiler-import ban.

Production uses a private declaration-only project derived from the consumer's
resolved configuration. It retains resolution and type settings, selects the
configured declaration roots and requested entrypoint, clears output/root
redirections, and disables emission. `noCheck`, `skipLibCheck`, and
`skipDefaultLibCheck` are forced to `false`: suppressed consumer build diagnostics
cannot qualify an invalid public declaration. The consumer files are unchanged.
Configuration, program, syntax, binding, global, semantic, suggestion, and
declaration diagnostics are collected from the actual native compiler. The rich auditor retains
its stricter admission of the original supplied configuration.

The native SDK owns one compiler process per observation. It receives a closed
virtual filesystem of staged declarations/configuration, captured installed
package declarations/configuration, and the pinned standard libraries. Missing
virtual reads return an explicit absence; the compiler cannot fall back to disk.
Installed packages are read as data, never executed. Compiler queries use the
public asynchronous SDK in deterministic sequence. The adapter awaits snapshot
disposal and session close in `finally` blocks; the SDK ends compiler input so
normal shutdown can finish through EOF. Cancellation is checked at bounded
phases; this does not promise preemption during an in-flight SDK query.

Dependency capture uses bounded regular-file handles, before/after identity
checks, at most 32 MiB per file and 128 MiB total, 20,000 files, 50,000 charged
directory entries, depth 128, and 1,024 packages. These mechanics retain the
external frozen-namespace precondition below; they do not establish a hostile
same-user filesystem sandbox. Audit request, observation, and report budgets
remain independently enforced.

Official model constructors own canonical identities, overload selectors,
container navigation, and member kinds. The adapter supports declaration aliases,
namespace exports, functions and callable variables, ordinary classes/interfaces,
properties, methods, accessors, enums, and call/construct/index signatures.
Paired accessors retain one official property identity and both declaration
excerpts, so removing or changing a setter remains visible to compatibility checks.
Private unique-symbol brands retain their upstream exemption; hidden ordinary
symbols do not. Unsupported owned declaration kinds and unprovable merged generic
or heritage headers fail closed in both projections.

The ordinary v1 extractor selects a private stored-surface projection. It retains
official item identities, kinds, parents, and exact printed signatures; v1 neither
stores nor compares external reference-token targets. The rich observer explicitly
selects declaration-graph projection, which also remains the private default.
The choice is made before extraction, never as a retry after graph failure.
Both projections retain compiler diagnostics, local forgotten-export traversal,
closed inputs, and the existing limits. They differ only in whether external
reference-token identities must be constructed and proved.

Declaration-graph projection rejects ambiguous external overload-reference sets
and unproved ambient target identities. The adapter never chooses the first
overload to stand for an entire callable. Valid public Node declarations such as
`typeof mkdir`, `Buffer`, and `NodeJS.Platform` can be stored as literal v1
signatures without claiming that their external targets are graph-qualified.
CommonJS `export =` is explicitly unsupported (`native-export-assignment`), as
are unqualified whole-module import types such as `typeof import("dependency")`
(`native-whole-module-import-reference`). These forms cannot qualify as an empty
surface or silently omit dependency edges.

The extractor identity is `typescript-native/7.0.2`. Rich observations also bind
actual compiler, model, and private adapter module bytes. This is a new native
toolchain, not an assertion of equality with the former extractor. In particular,
the in-memory model preserves actual hidden namespace visibility and local
builtin shadows, as described below.

### Release qualification remains required

Existing released baseline bytes and their original `extractorVersion` remain
unchanged. The ordinary checker still returns `baseline-tool-mismatch`, and
promotion still rejects `PUBLIC_API_BASELINE_PROMOTION_TOOL_MISMATCH`, when
versions differ. Identical declaration text is insufficient to waive either
check. A changeset or a successful native extraction is not baseline authority.

The private repository driver implements one closed eight-package transition.
It retains the old baseline B from commit
`4b9cc2165563361f463ca3c59277edc9af592c55`, observes the exact historical
declarations as native A, and observes the current candidate as native C. The
source-owned [input record](../../scripts/native-public-api-migration/intent.json)
binds the policy, every B/configuration/archive hash, the frozen declaration
dependency closure, each native A and the complete reviewed B-to-A difference
packet. It describes content; it grants no write authority.

Seven historical archives have verified npm signature and provenance evidence
for their exact publication commits, including Foundation `1.9.0`. At input
acquisition, Feature Module Standard `0.1.0` was not published: its recovered
archive matches both SHA-256 and SRI from the complete eight-archive
qualification in main release run `39172225427`, attempt 1. That
run ultimately failed. The driver checks its actual repository, commit,
workflow, event, attempt and retained qualification payload, and records the
artifact as a qualified release candidate. npm `11.19.0` installs the frozen
historical declaration closure with lifecycle scripts disabled. Old package and
compiler files are data and are never evaluated by this observation.

The earlier Foundation `1.8.0` packet from commit
`88c0853bfe29deca175a9b98d7685e577409f7f1` and release run `39134132899`
remains historical evidence. The fixed input refresh observes the actual new
release; it does not substitute the old FMS archive for the new qualified bytes.
Only the FMS archive's manifest changed, updating its Foundation dependency to
`1.9.0`. Its recovered compressed bytes still match the independent new run.

Independent review of the full packet found 256 signature-text differences:
214 whitespace changes and 42 archive-supported `export declare const` carrier
and trailing-semicolon differences. All 2,784 item identities, kinds, parents,
export paths and signature literal tokens are preserved. The actual A-to-C
comparison still uses the ordinary classifier, version and Changeset rules,
accepted-decision evidence and concrete artifact checks. A real API change or
any different B-to-A packet fails this named transition.

`foundation:check:built` runs the actual ordinary built CLI first. It preserves
the complete JSON report, stderr and actual exit code. Only the exact full
eleven-capability report containing the eight expected tool mismatches can
proceed to native migration qualification. An unrelated capability failure
rejects before archive acquisition. The separate migration report can qualify
the reviewed transition while the ordinary report still says `violations` and
records exit `1`; no diagnostic is filtered or relabeled as an ordinary pass.
Once committed baselines use the native tool, the ordinary successful route
requires no migration inputs or archive lookup.
The eight actual working baseline files must match the exact reviewed B bytes
both before archive acquisition and after native observation. A release-version
change in a baseline cannot reuse qualification for an older B packet.

Baseline replacement belongs to the existing main release workflow's version
step, described in [release preparation](../release.md#native-public-api-baseline-transition).
Normal typed and artifact preflight completes before mutation. The physical
writer retains the actual B preimage, and every typed anchor is checked again,
including exact postimages skipped during replay. This is a sequence of guarded
writes, not a claim of multi-file atomicity. The public read-only A/B/C audit
always remains `releaseEligible:false`; it cannot authorize this replacement.

The repository's native package type qualifier replaces the former
`@arethetypeswrong/cli@0.18.5` route, whose runtime embedded
`typescript@5.6.1-rc`. It retains publint, the complete publishable package
projection, and actual packed-byte qualification in Node16 ESM and Bundler
resolution modes. See the [bounded package contract](../development/quality-gates.md#native-package-type-qualification).
The [historical published-operation qualification](../development/quality-gates.md#historical-published-operations)
preserves the three named transaction and scaffolding compatibility scenarios
without executing old compiler-bearing CLI startup.

The single configuration schema `v1` covers every public export path of a
package and uses stable `decisionId` approvals. The released baseline must use
the stable package anchor, and raw ADR Markdown is never approval evidence:

```yaml
schemaVersion: 1
acceptedDecisionBaselinePath: architecture/decisions/accepted-decisions.json
packages:
  - packageName: "@agent-teams/engineering-foundation"
    entrypoints:
      - exportPath: "."
        declarationEntryPoint: packages/engineering-foundation/dist/index.d.ts
      - exportPath: "./local-mode"
        declarationEntryPoint: packages/engineering-foundation/dist/local-mode/index.d.ts
    nonTypeExports:
      - exportPath: "./package.json"
        kind: data
      - exportPath: "./schemas/*"
        kind: wildcard
```

Each snapshot stores an independently ordered surface for every
`exportPath`. The same API Extractor canonical reference is therefore allowed
in two paths without being merged. A root namespace export such as
`export * as localMode ...` is an additional root API, not a substitute for
checking the independently importable `./local-mode` path.

The contract is closed over the normalized `package.json.exports` map. Every public
typed subpath must appear exactly once in `entrypoints` and its declaration path
must match the package's `types` target. `data`, `wildcard`, and untyped
`runtime` exports must instead be named exactly once in `nonTypeExports`; a
typed wildcard is rejected until its concrete subpaths can be baselined. This
prevents a newly exported path from bypassing compatibility evidence.

## SDK growth checkpoint

The [C0 contract](../reference/sdk-growth-c0.md) freezes the separate
growth report, decision vocabulary, EF surface inventory and trust
prerequisites. Existing v1 schemas, baseline bytes and promotion semantics
remain authoritative.

### Current status: implemented, dormant (2026-09-25)

The v1 compatibility gate is the active SDK protection. It rejects breaking
changes (`breaking-change-not-approved`), runtime exports outside the closed
`package.json` `exports` contract described above, and policy or baseline
repointing through the ordinary `foundation:check` route.
Additions pass v1 and remain visible in the baseline diff and the growth
report, where the repository owner reviews them in the pull request.

SDK growth qualification ([v2](#sdk-growth-execution-v2-pre-s3)) and the
trusted authority entrypoint ([S3, protocol v3](../reference/sdk-growth-s3-authority.md))
are implemented and tested but intentionally not used. Without a trusted host,
v2 never produces a trusted pass or admits growth. The owner decided not to
build the host: the threat it covers, a pull request forging its own baseline
or approval, is unlikely while one owner reviews and merges every pull
request, and the owner's estimate for closing it is 1,500-2,500 lines across
ReviewRouter and EF. The Get Modular and Agent Runtime SDK growth profiles stay
unactivated. While this decision stands, G1/A3 activation and any C0 lane that
requires an activated G1, such as K1, remain blocked. The frozen C0 contract is
not edited.

Accepted limits of the active gate. A candidate pull request can rewrite a
released baseline in place, approve its own break through a new accepted ADR
and `approvedBreakingChanges`, drop a package from the policy, or replace the
consumer command with a no-op. None of these fails automatically. Each one is
visible in the diff, and review has to catch it.

Known v2 defect, not fixed while v2 is dormant: a package without wildcard
exports projects zero artifact entrypoints, but `package-public-api-baseline/v1`
requires at least one. A faithful released artifact observation is rejected by
the schema. A placeholder `.` entrypoint without items passes the schema but is
compared as a removed entrypoint, so v2 reports a false
`breaking-change-not-approved` on an unchanged package.

Revisit this decision when pull requests merge without owner review, for
example with external contributors or unattended agent auto-merge. Reviving
it requires:

- a ReviewRouter implementation of the v3 host port (its production
  composition used the v1 codec as of 2026-09-25), with a storage migration for
  multi-package custody;
- a real owner-approval authority behind ReviewRouter's trusted ingestion
  ports;
- a verifier runner that executes this entrypoint;
- public EF exports for the canonical digest helpers that the host needs;
- a trusted anchor outside the candidate for base, policy, decisions and the
  consumer command;
- a fix for the artifact-entrypoint defect above.

## Compatibility policy

- a new top-level export is additive and requires a minor Changeset;
- removing or changing an existing item is breaking;
- one comparison-time exception treats a direct top-level type-alias RHS as
  unchanged when its only difference is omitting or restoring trailing generic
  arguments. Every omitted argument must textually equal the corresponding
  declared default on one unambiguous, unchanged top-level public generic target
  in both the released and current snapshots. An omitted default that references
  any target type parameter, or whose leading name is shadowed by an alias type
  parameter, is not admitted without exact binding equivalence proof. A
  non-keyword default must resolve by name to exactly one byte-stable canonical
  public type, either in the same entrypoint or across the complete governed
  package set; missing, changed, dotted, or ambiguous bindings fail closed;
- adding a member beneath an already released class, interface, or namespace is
  conservatively breaking;
- before `1.0.0`, breaking changes require a minor bump; after `1.0.0`, a major
  bump is required;
- a package version cannot move behind its released baseline;
- a breaking change also requires an exact SHA-256 fingerprint and an approval
  reference to a currently accepted ADR whose identity and immutable path are
  verified against the accepted-decision baseline by `decisionId`;
- raw ADR Markdown, including `Status: Accepted`, is not approval evidence.

This exception is deliberately syntax-bounded rather than a general TypeScript
assignability engine. It admits only direct aliases and simple generic target
references with simple argument, constraint, and default texts. A changed or
ambiguous target, a different target name, a non-trailing omission, an omitted
parameter without a default, any other alias edit, or a nested or complex type
expression remains breaking. The complete alias type-parameter header must match
the bounded parameter grammar and remain byte-for-byte equal in both directions;
malformed and unsupported headers are not admitted. Failure to parse or prove
any required fact also remains breaking. Every direct alias argument must use
the same supported atom grammar, including arguments that are not omitted. The
comparator does not normalize,
regenerate, or rewrite the released baseline or the extracted current signature;
both retain their exact stored bytes.

The fingerprint contains old and new signatures, kinds, parents, every addition,
and every removal in the same change set. Approval of one break cannot authorize
a different change to the same symbol or an extra additive export.
API Extractor namespace items have no declaration excerpt, so the adapter records
the deterministic signature `namespace <displayName>`; every other empty
declared-item signature fails closed.

A breaking fingerprint also includes the export path and any added or
removed export path. Reordering configuration or snapshot entrypoints cannot
change the comparison result. A removed export path is breaking even when its
surface is empty; an added path is additive unless another change in the same
release is breaking.

## Released baseline lifecycle

The baseline is released evidence, not an editable expected-output fixture.
Normal checks never write it. `public-api-promote-release` writes it atomically
per package only after every configured package validates, the manifest version
advances enough for the observed change, and any breaking fingerprint has an
accepted decision. A replay after a process failure skips an already-promoted
unchanged package and finishes the remaining packages. Same-version API drift
fails closed. Extractor-version changes fail and require an explicitly reviewed
migration.

The accepted-decision baseline is consumed through a narrow public-API-owned
evidence port. Its governance-specific schema and lifecycle are translated by
an outbound ACL; public API policy imports neither governance domain types nor
raw ADR documents.

Each package has one deterministic release-owned baseline anchor:
`architecture/public-api/<package-local-name>.json`. The policy's
`releasedBaselinePath` must equal that anchor; it is not an arbitrary pointer.
That one baseline contains every public export path. This blocks
a pull request from redirecting compatibility checks to a newly created or stale
snapshot. Duplicate anchors are rejected, and the repository release gate still
protects creation, replacement, movement, and deletion under
`architecture/public-api/`.

Before independent production adoption, hardened corrections remain under the
single `v1` identity and all known consumers update in one coordinated release.
No feature PR may silently reset the baseline pointer. A future `v2` requires
the real migration boundary and explicit ADR defined by ADR-0019.

### Upgrading a provisional consumer

An older provisional consumer performs one release-owned update:

1. on a trusted release branch, move the existing baseline bytes without
   regenerating them to `architecture/public-api/<package-local-name>.json` and
   update `releasedBaselinePath`;
2. declare `governance.architecture-decisions`, create its stable configuration,
   promote the immutable accepted-decision baseline and convert approvals to
   stable `decisionId` values;
3. run the complete Foundation and consumer checks before promotion. A changed
   API fingerprint or an ADR absent from accepted immutable evidence still fails
   closed.

Do not restore a raw-Markdown fallback or generate a fresh API baseline merely
to make the upgrade pass. Either action would discard the released evidence the
capability is intended to protect.

Changesets invokes promotion after versioning. CI permits creation of a new
baseline during first adoption, but existing baselines can change only on
the same-repository `changeset-release/main` branch. Renaming or moving protected
baseline evidence is also a mutation. This prevents a feature pull request or a
same-named fork branch from rewriting both implementation and expected evidence.

The package comparison alone cannot prove who changed a Git file. A consumer
must therefore install an equivalent release-owned mutation check in required PR
CI before enabling this capability. Until Foundation exposes that check as a
reusable consumer command, the Foundation repository's own check is the donor
oracle and other consumers remain unqualified for activation.

## Bounded audit implementation boundary

Status: Implementation in progress; source CLI wiring and focused synthetic
conformance are present, but the full delivery contract is not yet qualified.

The audit belongs to `public-api-compatibility`. Its declaration graph projection
uses the existing `classifyPublicApiChange` policy and a distinct domain tag,
`foundation:public-api-audit:declaration-graph:1`. It must never enter a release
baseline or production promotion fingerprint. This is a bounded structural
comparison, without an assignability or semantic-equivalence claim.

Graph resolution identities retain subject, package, export path and opaque
canonical reference. Only the comparison serialization removes the subject
coordinate, allowing identical A and C graphs to compare equal. Hidden nodes
remain dependencies of public declarations. Ordered reference occurrences and
finite sorted reachable nodes preserve hidden mutations and cycles. Members of
referenced containers participate in the reachable graph.

The production extractor continues to exclude forgotten exports and rejects
failed extraction before publishing a snapshot. Shared native compiler mechanics
do not change that admission rule. Rich observations explicitly disable release-tag
trimming, so importable `@internal` exports participate in A/C comparisons.
Historical stored-surface mapping separately excludes internal containers and
forgotten exports, preserving the production model vocabulary. Missing compiler
exports in a rich model make that observation unsupported. Failed-extraction audit observations must retain
every diagnostic and may only support a rich comparison after independent
compiler, input, visibility and reference-boundary admission. They cannot become
successful extraction or release eligibility.

Historical B stored surfaces cannot establish discarded hidden nodes, reference
targets, compiler closure or original export visibility. A/B and B/C comparisons
must retain those limitations separately from A/C graph findings. The audit
operation is read-only and always has `releaseEligible:false`.

The current audit command implementation reads a fixed A/B/C request from
`--consumer <evidence-root> --config <request.json> --format json`. The two new
audit schemas are exported artifacts, not a JSON Schema family support claim.
A/C declare exact package manifests, export-path coverage, compiler configs,
input digests and a subject-local resolution universe. Archive and build custody
are supplied assertions; the command verifies supplied member/declaration bytes,
not registry provenance or execution of the claimed build.

The custody contract is content-addressed integrity under a caller-frozen input
namespace. The request is trusted configuration; its recorded digest is an
identity, not an independently authenticated trust anchor. Before invoking the
command, the evidence producer must finish and close all extraction/build writes,
then exclude writers to the evidence root, its ancestors, directory entries and
files until the audit finishes. Use a private, single-producer evidence directory
or an externally enforced immutable snapshot. A live build/extraction tree is
unsupported. This external freeze is a precondition, not a verified report fact.
Same-user adversarial writers and privileged writers are outside this contract.

Node's supported filesystem API has no portable `openat`/`openat2` directory
handle lookup on Windows, macOS and Linux. `O_NOFOLLOW` protects only the last
component on POSIX. Path `lstat`/`realpath` checks and handle snapshots detect
ordinary changes but cannot prove atomic parent containment: a writer can toggle
parents between every check and open. Consequently the auditor is not a sandbox
for hostile mutable paths, cannot promise that it never opens outside files, and
does not establish the physical provenance of matching bytes. Inventory digest
mismatches fail closed before baseline parsing or package-manifest use; matching
bytes alone never establish namespace custody. Repeated checks remain useful
mutation diagnostics, not evidence that the external freeze was enforced.
The regression deliberately toggles a parent between path checks and open:
different outside baseline bytes are rejected before admission, while identical
bytes are accepted without a containment claim. A separate concurrent-producer
test proves exclusive stage creation; it does not simulate an OS sandbox.

Compiler diagnostics are collected from the pinned native compiler Program
independently of model projection. Configuration dependencies and compiler
source files retain digests. A closed virtual filesystem exposes only declared
subject files and actual pinned standard libraries. Existing nested and enclosing
package manifests must be inventoried; their digests and subsequent presence are
revalidated. An enclosing manifest outside the evidence root is unsupported;
prepare evidence beneath a root where every influencing manifest can be declared.
The native observer receives a private staged copy of admitted bytes. The stage creator
exclusively creates a fresh directory, captures its inventory, completes every
write before publishing the stage, and rejects a second producer at the same
path. Release ends the stage lifetime and further revalidation fails. This is the
deterministic single-producer freeze barrier; it is independent of platform chmod
semantics. Read-only files and directories add defense in depth, but do not stop
an external same-user writer, nor freeze the original consumer namespace.
Adjacent declaration maps and mapped sources must be inventoried; flat v3 maps are supported and
indexed maps remain an explicit unsupported boundary. Map sources and manifest
metadata paths must remain inside the subject's admitted inventory. Undeclared
map or TSDoc metadata presence, escaping paths, and symlinks fail before SDK use.
Relevant absence observations and both original and staged bytes are revalidated;
detected changes prevent complete evidence under the frozen-namespace
precondition. Staged paths are translated back to input coordinates in compiler evidence. The copy is removed after observation.
The observer supplies the same closed native Program to the model adapter and
independent diagnostic collector, with no unrestricted filesystem fallback.
Declaration-only inputs, explicit config files,
unsuppressed compiler diagnostics and bounded inventories are required. Globs,
plugins, project references and unknown external module bindings fail closed.
The fixed standard-library boundary is AbortSignal, Error, Extract, NoInfer,
Promise, Readonly, Record and Uint8Array. Admitted symbol declarations must all
belong to the actual pinned compiler libraries; merged augmentations prevent
that admission. Rich audit observation always supplies the pinned compiler's
`lib.dom.d.ts` as a fixed input so an explicit non-web consumer `lib` cannot
make the observer depend on an incidental web-library setting; the existing
compiler and observation byte budgets include those bytes. Production extraction
retains forgotten-export enforcement and independently forces complete checking
of its declaration inputs. Primitive keyword
text creates no invented reference edge.

TSDoc parsing uses the pinned TSDoc configuration and parser. The report preserves
message severity and text, replacing only the disposable model-output directory
with `<audit-model-output>` for deterministic serialization. Error diagnostics
and failed invocation state survive bounded findings. Exit 2 includes failed,
unsupported or incomplete evidence; a nonempty diff alone does not cause failure.

The observer consumes the official in-memory model. Its hidden namespace child
`audit-fixture!~Hidden.Box:class` has `isExported:true` relative to its container
and `public:false` through its hidden parent. The native reference binds to that
exact identity. Model 7.33.10 loses this relative flag when deserializing the saved
model and changes the identity to `audit-fixture!~Hidden~Box:class`; this is why
rich observation does not use that lossy reload. Actual saved model bytes and
their digest remain evidence, with no lossless-reload claim. Malformed or
ambiguous references are still rejected. A local `Promise` shadow likewise keeps
its actual local identity instead of an invented legacy suffix or library proof.

Cross-package graph resolution retains the compiler's actual module binding and
the declared export-path coordinate for each occurrence in its unique compiler
declaration. Named and namespace imports and inline import types establish their
own bindings;
an unused named import cannot authorize another occurrence's inline import path.
Indeterminate declaration matches or occurrence counts remain unresolved.
Reusing a canonical reference through two
export paths does not merge those scopes. A reference with multiple remaining
bound scopes stays ambiguous; the adapter never selects the first matching name.
The executable audit tests retain flat paths and exact capability ownership.
The native observer and graph projection tests use ordinary `.test.ts`; the
production extraction suite also has strict TypeScript coverage and explicit
shard/Windows-lane assignments. Existing tests retain their required routes.

A package with no typed export paths retains an independently checked compiler
observation with `modelExpected:false` and a null export path. It does not claim
a model-extraction invocation or invent a model. Empty projections retain package
metadata, so removing the final typed export remains a comparable change.

Admission is scoped to each package and its referenced dependencies. An unrelated
invalid package or historical baseline does not erase available findings. A/C
input and custody validation remains fail-closed. Historical B files are read,
digest-checked and mapped at the per-package baseline boundary; a failure makes
that package’s A-B/B-C comparisons unavailable and the report incomplete with
exit 2, while independently valid A-C findings remain. Duplicate historical
package names remain structural request errors. A/C input and custody
inventories share a budget of 4,096 files and 32 MiB. All declared B entries,
including packages absent from A/C, share a separate audit-local budget of
4,096 files and 32 MiB and are validated once inside the isolated package path.
Byte reservations are monotonic even when a file shrinks or a read fails; a
growth probe is charged in addition to the original reservation. B-only packages
remain unavailable for historical comparisons. B budget failures
are retained as B errors without invalidating independent A-C evidence. Each
subject permits 64 compiler/model observations and 64 MiB of retained observations. Comparison
serialization is bounded to 16 MiB. Exhaustion makes the affected scope
unavailable with a reason. Closed report schemas distinguish unavailable
comparisons from findings and require the corresponding eligibility evidence.

The adapter and independent diagnostics use the same pinned native TypeScript 7
SDK types. No structural facade imports an older compiler. Supplied archive
digests, archive inventory completeness and build execution
remain explicitly unverified custody assertions.

The existing packed consumer qualification workflow now exercises the public
binary selected from the installed manifest, both public schema exports,
successful internal-export mutation, retained failed-extraction findings, invalid
input, and byte immutability. Packed and full verification remain controller-owned.
The private `load-pinned-audit-sdk.ts` adapter owns fixed native SDK resolution
and identity. It accepts no module names or resolution roots from callers and
has no inward feature dependency. It validates TypeScript and the actual platform
native package at 7.0.2 and model 7.33.10 before observing inputs. The loader and
all remaining adapter roots stay governed, disjoint and without opaque runtime
reference permission. Equivalent opaque loads fail the unchanged source-dependency
evaluator in every adapter, including the loader.

Consumer Module Standard applicability: this file is a private outbound SDK
adapter within the existing Foundation platform capability and public package,
not a new consumer module, assembly or public export. The existing Feature Module
Standard adapter ownership therefore remains authoritative; no Get Modular
construction/adoption or consumer conformance claim is introduced. The exact
source boundary partitions dependency permission without creating another feature.

Graph records are sorted before both signature serialization and exposed node
output; ordered reference occurrences remain ordered. Cleanup independently
attempts permission restoration and owned temporary-directory removal. Either
failure retains invocation, model and diagnostic evidence, records an
`owned-resource-cleanup` reason naming the operation and owned path, and makes
the report incomplete with exit 2. Such paths identify cleanup debt for the
operator; failure reports are not claimed byte-deterministic across disposable
resource names.

Namespace import tokens and forwarded exports require actual native compiler and
model bindings. Any unproved target or ambiguous export path fails closed; an
unrelated import never supplies authority for it. Current synthetic tests do not establish
an actual Get Modular A/B/C audit or consumer release admission.

### SDK growth execution (v2, pre-S3)

Configuration `schemaVersion: 2` explicitly selects SDK growth in the existing
`package.public-api-compatibility` check. Its closed `sdkGrowth` object supplies
workspace selection, invocation identities, context paths and one report slot
with an expected preimage digest (or `null` for creation). The remaining fields
use the unchanged v1 mapper. Schema v1 and existing baseline bytes retain their
semantics; installing this implementation does not migrate a consumer profile.

`trustedBasePath` names a complete S1 observation, and `decisionsPath` names an
array of exact decision records. Each released `observationPath` names a closed
`{typed, artifact}` pair of original v1 compatibility snapshots. An initial
history input contains only `historyDigest`. All inputs are bounded, contained
regular files. A missing file retains unavailable evidence; malformed inputs
and embedded `status: verified` claims are rejected. These files establish
content identity only: retained history, initial-release status and owner
authority remain unverified before S3, even when every decision matches.

The report retains invocation identities, candidate observation and coverage,
base reference, authority status, exact transitions, decision diagnostics and
independent release compatibility findings. It grants no release authority.
The aggregate diagnostic `package.public-api-compatibility.sdk-growth-report`
binds the report path and SHA-256. Existing outcome codes apply: passed `0`,
violations `1`, incomplete/invalid input `2`, execution/publication failure `3`,
and cancellation `130`. Pre-S3 filesystem execution cannot produce a trusted
pass; matched decisions still produce `SDK_GROWTH_INCOMPLETE` and exit `2`.
Publication conflict, IO and uncertainty have separate stable problem codes.
V2 release promotion remains gated on the separately qualified S3 route.

The [release-owned v2 corpus](../../architecture/contracts/sdk-growth-v2/identity.json)
pins the new schema bytes and positive/negative fixtures at contract version
`2.0.0`. The existing packed package gate invokes
`scripts/pack-sdk-growth-test.mjs` against separately built and packed synthetic
packages through the installed binary and exported schema. This is development
qualification, not GM/AR activation or registry release evidence. V2 remains
artifact-protected: no new JSON Schema family support claim is made, and the
existing `contract.json-schema-releases` scope is unchanged.
The [first-surface record](../../architecture/contracts/sdk-growth-v2/first-surface.json)
and [evidence](../../architecture/contracts/sdk-growth-v2/first-surface-evidence.json)
bind the one added concrete schema export to its exact S1 value and transition.
They are unverified admission proposals. Their content-addressed source tree
contains only the named qualification script, not a repository commit; packed
qualification and trusted approval remain distinct claims.

The capability owns a private `GrowthReportWriter` port and filesystem adapter
for one replaceable report slot. Parent directories must exist, all path
components must be contained and nonsymlinked, and an existing slot must be a
regular file with one link. A same-directory exclusive fence serializes
cooperating writers; exact preimage checks prevent lost updates, and identical
bytes replay without requiring the original preimage to remain current.
Temporary bytes are synced before rename. Cancellation before rename removes
owned staging and fence files; cancellation after rename begins does not undo
publication. Conflict, IO failure and uncertain publication are distinct errors.
Uncertain writes may be retried with identical bytes and the original preimage.

This is atomic single-slot publication, without stale-fence takeover or a new
durable journal. Process death can leave a fence requiring operator inspection;
power-loss durability and protection from hostile ancestor replacement are not
claimed. Trusted isolation remains S3 work. The report confers no authority.
Trusted integration and consumer activation remain S3/G1/A3 obligations.

CMS review: the previously reviewed complete GM document at
`610e595fe1f2e893d01ee44ceecd6349b5a3c8ce` has full-document SHA-256
`d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f`.
Current GM revision `bec157f1b7c317dd063a95103fc0b1d440976b9c` has
full-document SHA-256 `33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd`.
Its new optional dynamic Host lifecycle candidate does not change the fixed
private-helper rule here: this adapter stays within the existing capability
and Pure DI composition. No Assembly adoption or CMS pin migration is introduced.
The existing FMS pin and governed roots remain in force.

### Qualified non-release workspace metadata root (S3 authority v3)

[ADR-0055](../decisions/0055-qualified-non-release-metadata-root.md) authorizes
one narrow distinction between full topology and release obligations. A root
stays in inventory, source identity, transitions and report coverage. Only
authenticated consumer-owned classification bound to exact base and candidate
source bytes may omit its archive and release baseline. All governed packages
and surviving historical release obligations remain covered across the union.
The [C0 successor boundary](../reference/sdk-growth-c0.md#revision-6-qualified-non-release-metadata-root)
and [S3 protocol](../reference/sdk-growth-s3-authority.md#qualified-metadata-root)
own the closed evidence, rejection rules and unchanged 120-second deadline.
Private flags and missing exports confer no exemption.

## Shared native transition command

The [native tool-transition contract](../reference/public-api-native-transition.md)
extends the existing public `public-api-promote-release` command with one explicit
7.58.12-to-native-7.0.2 content input and a read-only qualification mode. The
shared mechanism serves Foundation's fixed eight-package migration and a real
Get Modular two-package consumer. Consumer archive authentication and reviewed
data stay with the consumer; normal mismatch guards and trusted release ownership
remain unchanged. No SDK-growth host or new publication authority is introduced.
