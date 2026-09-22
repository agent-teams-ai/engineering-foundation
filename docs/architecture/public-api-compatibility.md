# Public API Compatibility

Status: Accepted and implemented by ADR-0004. Consumer activation remains gated
on release-owned baseline mutation enforcement in that repository.

`package.public-api-compatibility` compares built declaration entry points with
a committed snapshot of the last released TypeScript API. API Extractor is an
outbound adapter; its model types do not cross into capability policy.

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

The [C0 contract](../reference/sdk-growth-c0.md) freezes the separate future
growth report, decision vocabulary, EF surface inventory and pending trust
prerequisites. S1–S3 are not implemented or activated by this checkpoint. Existing
v1 schemas, baseline bytes and promotion semantics remain authoritative.

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
failed extraction before loading a model. Shared adapter configuration does not
change that admission rule. Rich observations explicitly disable release-tag
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

Compiler diagnostics are collected from the pinned Extractor compiler Program
independently of message callbacks. Configuration dependencies and compiler
source files retain digests. A verified compiler host exposes only declared
subject files and actual pinned standard libraries. Existing nested and enclosing
package manifests must be inventoried; their digests and subsequent presence are
revalidated. An enclosing manifest outside the evidence root is unsupported;
prepare evidence beneath a root where every influencing manifest can be declared.
Extractor receives a private staged copy of admitted bytes. The stage creator
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
The observer supplies the same verified Program to Extractor and the independent
diagnostic collector, avoiding the unrestricted compiler-state factory.
Declaration-only inputs, explicit config files,
unsuppressed compiler diagnostics and bounded inventories are required. Globs,
plugins, project references and unknown external module bindings fail closed.
The fixed standard-library boundary is AbortSignal, Error, Extract, NoInfer,
Promise, Readonly, Record and Uint8Array. Admitted symbol declarations must all
belong to the actual pinned compiler libraries; merged augmentations prevent
that admission. Rich audit observation always supplies the pinned compiler's
`lib.dom.d.ts` as a fixed input so an explicit non-web consumer `lib` cannot
make API Extractor misclassify `AbortSignal`; the existing compiler and
observation byte budgets include those bytes. Production extraction retains its
unchanged forgotten-export enforcement and compiler inputs. Primitive keyword
text creates no invented reference edge.

TSDoc configuration comes from the pinned Extractor base. The report preserves
message severity and text, replacing only the disposable model-output directory
with `<audit-model-output>` for deterministic serialization. Error diagnostics
and failed invocation state survive bounded findings. Exit 2 includes failed,
unsupported or incomplete evidence; a nonempty diff alone does not cause failure.

The hidden-namespace boundary remains explicit:

- The pinned SDK can emit a token `audit-fixture!~Hidden.Box:class` while its
  hidden namespace member model identity is `audit-fixture!~Hidden~Box:class`.
  These are distinct opaque identities. Visibility and historical observations
  remain available, but the rich graph is unavailable with an unresolved
  reference. The audit never rewrites navigation to manufacture a binding.

Cross-package graph resolution retains the compiler's actual module binding and
the declared export-path coordinate for each occurrence in its unique compiler
declaration. Named imports and inline import types establish their own bindings;
an unused named import cannot authorize another occurrence's inline import path.
Indeterminate declaration matches or occurrence counts remain unresolved.
Reusing a canonical reference through two
export paths does not merge those scopes. A reference with multiple remaining
bound scopes stays ambiguous; the adapter never selects the first matching name.
The five executable audit tests use flat `public-api-audit-*.test.mjs` paths with
exact capability ownership and shard mappings, preserving the manifest gate.

A package with no typed export paths retains an independently checked compiler
observation with `modelExpected:false` and a null export path. It does not claim
an Extractor invocation or invent a model. Empty projections retain package
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

The adapter uses the compiler shipped with the pinned Extractor, including for
independent diagnostics. Narrow structural compiler views permit the repository
build toolchain to typecheck this adapter without introducing another compiler.
Supplied archive digests, archive inventory completeness and build execution
remain explicitly unverified custody assertions.

The existing packed consumer qualification workflow now exercises the public
binary selected from the installed manifest, both public schema exports,
successful internal-export mutation, retained failed-extraction findings, invalid
input, and byte immutability. Packed and full verification remain controller-owned.
The private `load-pinned-audit-sdk.ts` adapter owns the fixed Extractor-relative
TypeScript and TSDoc loading operation. ADR-0002's existing `commonjs` runtime
reference permission applies only to that exact file. All remaining adapter
roots stay governed, disjoint and without runtime-reference permission. The
loader accepts no module names or resolution roots from callers, has no inward
feature dependency, and exposes only private SDK values and identities to the
observer. The observer still validates Extractor 7.58.12, model 7.33.10 and the
actual Extractor-owned TypeScript 5.9.3 before observing inputs. Equivalent opaque
loads in any other adapter fail the unchanged source-dependency evaluator.

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

Qualified namespace import tokens and forwarded exports remain unsupported when
compiler/model bindings cannot be established; they fail closed rather than
borrowing unrelated import authority. Current synthetic tests do not establish
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

CMS review: the current complete GM document at `610e595fe1f2e893d01ee44ceecd6349b5a3c8ce`
has SHA-256 `d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f`.
Its fixed private-helper rule applies: this adapter stays within the existing
capability and Pure DI composition. No Assembly adoption or CMS pin migration
is introduced. The existing FMS pin and governed roots remain in force.

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
