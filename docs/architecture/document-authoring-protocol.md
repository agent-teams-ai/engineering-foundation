# Document Authoring Protocol

Status: Corrected Intent, Plan, and Receipt v1 contracts are retained from
ADR-0023. ADR-0024 introduced envelope v3, document journal v2, and
recovery-handler contract v2. ADR-0026 supersedes ADR-0025 and adds
Plan/Receipt v2, envelope v4, document journal v3, and recovery-handler contract
v3. Published older evidence remains immutable and is never reinterpreted.
The catalog, compiler, create-only writer, `docs new`, `docs doctor`, and
`docs recover` are implemented and released. Packed registry and cross-platform
qualification evidence supports release adoption; consumer activation remains
explicit.

ADR-0026 carries forward ADR-0025's placement of the unified documentation CLI
and metadata/query workflow in the separate `@agent-teams/docs-protocol`
package. This document remains the
canonical Foundation mutation-kernel and persisted-evidence specification.
Docs Protocol depends on these mechanisms; Foundation does not depend on Docs
Protocol. The vNext directory-materialization extension binds every missing
allowed parent segment and its observed physical identity into its Plan and
journal. Portable Node recovery is retain-only and never deletes a created
directory.

## Boundary

Document authoring is a top-level mutation protocol. It is not a capability,
does not run inside `foundation check`, and is not a scaffolding recipe. Its
public contracts are document-specific; only private Foundation coordination
and filesystem mechanisms may later be shared with scaffolding.

Foundation owns deterministic observation, contract validation, compilation,
safe materialization, recovery, stable diagnostics, and package qualification.
A consumer owns every repository-specific meaning. Foundation never loads
consumer code or treats a profile as an extension language.

## Rule ownership matrix

| Rule or fact | Authority | Foundation responsibility |
| --- | --- | --- |
| Allowed metadata shape | Consumer metadata schema | Render canonically, then validate the compiled instance |
| Create-enabled document types | Consumer authoring profile | Select one closed v1 strategy and reject partial authority |
| Initial status and creation defaults | Consumer authoring profile | Apply and validate them |
| Allowed owner identifiers | Consumer owner catalog | Prove exact membership |
| Meaning of an owner identifier | Consumer domain | Keep it opaque |
| Path reviewers | Consumer `CODEOWNERS` | No interpretation |
| Body structure | Consumer body template | Extract one strict fenced skeleton and replace its placeholder H1 |
| Current identifiers and paths | Complete rebuilt document catalog | Detect duplicate identity or path; never plan from `partial` |
| `related` set | Document Intent | Normalize unique values in binary order |
| Blockers, code anchors, and other metadata | Document Intent plus consumer schema | Preserve bounded caller order and opaque meaning |
| Slug or explicit destination | Document Intent when selected placement consumes it | Validate or deterministically derive; never ignore |
| Qualified identity grammar and placement operators | Consumer authoring profile | Execute only closed v1 operators |
| Blocker and code-anchor semantics | Consumer validator | No generic interpretation |
| Generic links and anchors | Foundation documentation checks | Validate read-only integrity |
| RC reachability instruction | Consumer authoring profile | Project the exact index path and relative Markdown link without editing the index |
| Safe file publication | Foundation authoring protocol | Enforce Plan and adapter contract |
| Transaction coordination | Private Foundation coordinator | Serialize Foundation mutations |
| Agent routing | Existing `repository.agent-workflow` | Validate the declared route |
| Prose and diagram tools | Consumer exact lockfile and checks | Never execute them from a profile |
| Organization requirements and exceptions | Central policy repository | Outside this protocol |
| Portal and search presentation | Rebuildable derived system | Never write canonical sources |

The metadata schema answers which final document is valid. The authoring profile
answers which initial document may be created. They are intentionally separate.

Profile v3 may define local named owner sets once under
`authoring.ownerSets: {schemaVersion: 1, sets: {...}}`. Each artifact type then
selects exactly one `ownerSetId`, or keeps an explicit `allowedOwnerIds` list.
The forms are mutually exclusive, every referenced set must exist, and every
effective member must still exist in the owner catalog. There is no implicit
catalog-wide set: adding an owner cannot silently expand authoring authority.
Owner-set resolution does not centralize metadata schemas, templates, or domain
meaning.
Foundation does not infer creation defaults from arbitrary JSON Schema.

## Read-only catalog

`@agent-teams/engineering-foundation/document-authoring` exposes
`buildDocumentationCatalog`. The caller supplies one explicit profile path. The
catalog reads the closed profile, local metadata schema, owner map, and declared
Markdown collections without running consumer code or external tools.

Discovery uses binary path ordering, skips declared excluded prefixes before
reading, rejects malformed UTF-8, and rejects BOM or NUL sources at the catalog
boundary. Metadata schema references must remain local fragments. A second
corpus pass and authority recapture detect observed drift. Invalid documents do
not hide valid neighbors: the result is `partial`, preserves bounded stable
diagnostics, and retains safe identity projections needed to prevent accidental
ID reuse.

The catalog detects duplicate IDs and case/NFC path collisions. Its identity
projection contains only ID and repository path. Referenced-document projection
is built only for the explicit IDs a later use case actually consumes; unrelated
document bodies never enter that evidence. Catalog construction performs no
repository mutation and does not read a generated search index.

## Read-only planning

`planDocumentationDocument` validates and normalizes one Intent, rebuilds a
complete catalog, resolves a closed profile strategy, renders exact canonical
UTF-8/LF bytes, recaptures authority, and returns a schema-valid Document Plan.
Plan v1 requires the destination parent to exist as real directory ancestry.
Plan v2 instead observes the deepest existing real anchor and binds every
missing segment without creating it during planning. Both fail closed on
portable-name, identity, path, special-file, or false-self collisions. Planning
does not acquire a mutation lock, reserve an ID, write a file, or promise that a
later apply will succeed; apply must recompile and compare the exact Plan under
the operation lock.

## Canonical agent and operator CLI

The normal agent path is intentionally smaller than the internal
`Intent -> Plan -> Apply -> Receipt` protocol:

```bash
agent-teams-docs find "tenant isolation"
agent-teams-docs new --type adr --id ADR-0083 \
  --title "Tenant isolation" --owner architecture/tooling \
  --summary "Defines the tenant-isolation boundary and its verification evidence." \
  --dry-run
agent-teams-docs new --type adr --id ADR-0083 \
  --title "Tenant isolation" --owner architecture/tooling \
  --summary "Defines the tenant-isolation boundary and its verification evidence." \
  --apply
pnpm check
```

`--type`, `--id`, `--title`, `--owner`, and `--summary` are required by
`docs new`. Foundation never invents an owner or summary. `--slug`,
`--destination`, repeatable `--related`, `--profile`, and `--consumer` remain
explicit inputs when the selected profile strategy permits them. Automatic ID
allocation is not part of this version.

`docs new` first inspects the shared transaction state, compiles from a fresh
complete catalog, reports deterministic similar-document advice, projects the
consumer-authorized reachability action, and then either previews or applies.
`--dry-run` is non-reserving and performs no repository mutation. Review the
preview, repeat the same command with `--apply`, then follow the emitted
`Next:` instruction:

- for manual reachability, add the emitted exact Markdown link to the emitted
  index path;
- when no manual reachability step is required, run the consumer's standard
  complete repository check.

The RC writer does not edit an index. Managed reachability is a later qualified
transaction, so the profile is the only authority for a manual index action.

Operator commands are separate from the happy path:

```bash
agent-teams-docs doctor
agent-teams-docs recover
```

`docs doctor` is read-only. It reports installed package/build identity,
filesystem durability support, transaction and protocol kind, automatic versus
manual recovery, and an exact recovery command only when authority proves one.
`docs recover` operates only on an exact compatible document transaction. It
does not force, clean, roll back a published destination, delete conflicts, or
reinterpret foreign, corrupt, unknown-version, or manual-recovery evidence.

## Published language

### Document intent v1

An Intent contains the complete caller-controlled input to compilation:

```text
schemaVersion
type
id
title
owner
summary
slug?          # path-affecting, closed lowercase ASCII grammar
destination?   # path-affecting, portable repository-relative path
related?
additionalMetadata?
```

`type`, `id`, `title`, `owner`, and `summary` are required. `slug` and
`destination` are optional in the schema but their semantic presence is closed
by placement:

| Placement and filename | `slug` | `destination` |
| --- | --- | --- |
| `collection` with `numeric-id-slug`, `id-slug`, or `slug` | Optional input; compiler derives it from title when absent | Forbidden |
| `collection` with `README.md` | Forbidden | Forbidden |
| `qualified-leaf-index` | Forbidden | Forbidden |
| `explicit` | Forbidden | Required |

The identity/placement compatibility matrix is also closed:
`qualified-leaf-index` is valid only with `identity.format: qualified`, and a
`collection` using `numeric-id-slug` is valid only with
`identity.format: adr-four-digits`. Every other v1 identity/placement
combination admitted by the public schema is allowed.

An unused path-affecting value is invalid; it is never silently ignored. Intent
normalization NFC-normalizes strings where the v1 schema admits Unicode, derives
or validates the slug, sorts the Foundation-owned `related` set in binary order,
and deep-freezes the result. Duplicate `related` entries are invalid.

`additionalMetadata` is bounded inert JSON data. Foundation does not interpret
consumer lifecycle, blocker, code-anchor, or relationship meaning. It rejects a
top-level key that could replace `id`, `type`, `status`, `owner`, `summary`,
`slug`, `destination`, or `related`, and recursively rejects `__proto__`,
`prototype`, and `constructor`. Consumer-owned arrays preserve caller order.

### Document Plan v1 and v2

A Plan binds the exact compiler version and build identity, canonical Intent and
domain-separated digest, project identity, profile and metadata schema evidence,
selected owner and membership digest, template, minimal identity projection,
used document references, logical parent expectation, destination,
absent-file precondition, exact output bytes, adapter capabilities, diagnostics,
and domain-separated Plan digest.

A Plan never contains an absolute path, timestamp, process identifier, locale,
environment value, arbitrary executable configuration, or an unbounded corpus.
Its parent expectation is repository-logical evidence:
`{path,state:"directory",ancestry:"real-directories"}`. It deliberately does
not contain inode, device, absolute path, or another platform-specific identity.
`expectedParent.path` is the POSIX dirname of `destination`; exact `.` denotes
the repository root and is valid only in this expected-parent coordinate.
Plan v1 requires that parent to exist before compilation. Plan v2 instead binds
the deepest existing real-directory anchor, the exact ordered missing segments,
and the explicit `create-missing-real-directories` policy. It also binds the
profile semantic digest plus catalog preimage and expected-postimage semantic
digests, so the same Plan reproduces both before and after its own publication
while unrelated catalog drift fails closed. The filesystem adapter recaptures
the root, anchor, every bound segment, and final parent under the operation lock.

### Document receipt v1

A Receipt reports only observed facts: Plan digest, adapter contract,
destination, outcome, optional proven result digest, commit observation, stable
diagnostics, and Receipt digest. It does not prove semantic completeness,
evidence quality, related-document updates, architectural acceptance, or
consumer check success.

### JSON command envelopes

Every docs command accepts `--json`. `docs find` emits the read-only document
command envelope v1. `docs new`, `docs doctor`, and `docs recover` emit document
mutation command envelope v2. Machine mode writes exactly one bounded JSON
object with a stable command, outcome, structured diagnostics, and
command-specific result. Human text never shares stdout; stderr is reserved for
an emergency launcher failure before a command envelope can be produced. Paths
always use `/`, zero search matches are success, sorting is stable, and
timestamps or durations are excluded. Remediation is a command identifier plus
bounded arguments, not a preformatted shell command.

A `docs new --dry-run --json` result reports `writeState: "preview"` and
`reservation: "none"`. A manual reachability result contains both the exact
`indexPath` and `markdownLink`. Doctor and recovery never manufacture a recovery
route when exact transaction authority is unavailable.

| Exit code | Stable meaning |
| ---: | --- |
| `0` | Success, zero matches, already applied, or no recovery required |
| `1` | Conflict, violation, stale authority, or recovery required |
| `2` | Invalid arguments, authority configuration, Intent, or Plan |
| `3` | Execution failure |
| `130` | Cancellation |

## Authoring profile v1

Profile v1 is `create-only` and admits only these closed primitives:

- identity: `adr-four-digits`, `open-decision-three-digits`, `qualified`;
- placement: `collection`, `qualified-leaf-index`, `explicit`;
- filename: `numeric-id-slug`, `id-slug`, `slug`, `README.md`;
- heading: `title`, `id-colon-title`;
- reachability: `manual-fixed-index`, `manual-colocated-index`, `not-required`;
- template: one bounded local UTF-8 file containing exactly one fenced Markdown
  skeleton with placeholder frontmatter and one leading H1; the compiler strips
  and replaces those two placeholders.

It prohibits automatic identity allocation, arbitrary regular expressions or
globs, commands, callbacks, hooks, dynamic imports, environment interpolation,
remote templates or schema references, inheritance, conditional rules,
directory creation, updates, deletion, free-form index editing, and arbitrary
filesystem paths.

`manual-fixed-index` binds one exact portable `indexPath` in consumer authority.
`manual-colocated-index` is valid only for explicit placement and projects the
literal `README.md` before the required placement segments, such as a package
README before `src/features`. Foundation derives the relative Markdown link
from that index to the compiled destination. `not-required` emits no index
action. None of these strategies mutates an index or claims managed
reachability.

### Identity grammar

`adr-four-digits` accepts exactly `^ADR-[0-9]{4}$`.
`open-decision-three-digits` accepts exactly `^OD-[0-9]{3}$`.

A qualified identity must declare this data-only grammar:

```yaml
identity:
  kind: explicit
  format: qualified
  grammar:
    prefixSegments: [domain, contexts]
    minSuffixSegments: 1
    maxSuffixSegments: 1
```

Every dot-delimited segment matches `^[a-z][a-z0-9-]*$`. The candidate must
start with the exact declared prefix, and the number of following segments must
be within the inclusive bounds. The prefix is part of consumer authority;
Foundation does not infer it from type names or placement.

### Filename and placement operators

The slug algorithm is exact and versioned: NFKD-normalize the title, remove only
combining marks U+0300 through U+036F, call JavaScript `toLowerCase`, replace
each maximal run outside ASCII `[a-z0-9]` with `-`, then trim leading and
trailing `-`. A supplied or derived result must match
`^[a-z0-9]+(?:-[a-z0-9]+)*$`; an empty derivation requires an explicit slug.
The algorithm is not the GitHub heading-anchor slugger.

Collection filenames are literal operators:

| Operator | Filename |
| --- | --- |
| `numeric-id-slug` | four digits from an `ADR-NNNN` ID, `-`, slug, `.md` |
| `id-slug` | full ID, `-`, slug, `.md` |
| `slug` | slug plus `.md` |
| `README.md` | literal `README.md` |

`qualified-leaf-index` declares singular `root` and `requiredBasename`. It
removes the qualified identity's declared prefix, maps each remaining identity
segment to one path segment without rewriting it, and appends the literal
basename. It accepts no caller destination.

`explicit` requires a caller destination, plural `allowedRoots`, one non-empty
`requiredSegmentsInOrder` list, and literal `requiredBasename`. A destination is
valid only when exactly one root matches on a complete segment boundary, the
required segments occur as one contiguous sequence, and the basename is exact.
`minimumSegmentsBeforeRequired` counts segments after that matched root and
before the required sequence; `minimumSegmentsAfterRequired` counts segments
after the required sequence and before the basename. The basename itself is
excluded from both counts. The feature donor normalization requires `1` before
and `1` after, matching `<project>/src/features/<feature>/README.md` beneath an
allowed top-level root.
Roots that collide under NFC plus case-folding, duplicate, or are ancestor and
descendant of one another are invalid profile authority.

### Portable paths and resource limits

Destination parents must already exist and be real directories. Paths use `/`,
ASCII segments `[A-Za-z0-9._@-]+`, at most 512 UTF-8 bytes total and 255 bytes
per segment. Empty, `.`, `..`, absolute, drive-qualified, UNC, backslash,
control, non-ASCII, colon/NTFS ADS, trailing-dot, trailing-space, and Windows
device-name components are invalid. Collision checks use NFC plus
locale-independent case folding.

The current limits are part of v1: profile, metadata schema, and owner catalog
authority files are each at most 1 MiB; a template is at most 256 KiB; compiled
output is at most 1 MiB; an owner catalog has at most 4,096 owners; catalog
observation admits at most 10,000 documents and 32 MiB total; identity
projection admits at most 100,000 entries. Field, item, nesting, scalar,
diagnostic, and encoded-output limits remain exactly those in the published v1
schemas. Both character and UTF-8 byte bounds are enforced when specified.
For in-memory callers, Foundation rejects shared-object amplification as soon
as an NFC-normalized lower bound of the logically expanded document fields
exceeds the same public 1 MiB output ceiling. This proves an existing output
failure before schema traversal; it does not add a wire-contract limit.

### Template and canonical Markdown transform

The bounded UTF-8 template contains exactly one fenced block whose info string
is `markdown`. After CRLF-to-LF normalization, the skeleton inside that block
must begin with a strict YAML mapping and then exactly one leading H1. YAML tags,
anchors, aliases, duplicate keys, interpolation, includes, callbacks, and
executable expressions are invalid. Foundation discards the placeholder
frontmatter, replaces the placeholder H1 through `title` or `id-colon-title`,
and retains the body beneath that H1. Content outside the single skeleton is
not copied into output.

Canonical frontmatter uses this key order:

1. `id`, `type`, `status`, `owner`, `summary`;
2. present `related`;
3. every additional metadata key in binary order.

`related` is unique and binary-sorted because Foundation owns that set.
Every consumer-owned array preserves caller order and every nested mapping uses
binary key order. Foundation has no knowledge of consumer field names. The
governed keys `id`, `type`, `status`, `owner`, `summary`, `related`, `title`,
`slug`, and `destination` cannot be supplied as additional metadata. The
rendered metadata must round-trip through the strict YAML data model and pass
the consumer metadata schema. Output is UTF-8 with LF, one terminal newline,
and logical mode `0644`.

The adopted donor corpus remains raw provenance evidence. Five of its six
documents are exact Foundation output vectors. The feature document is an
intentional semantic-equivalence vector: the donor preserves insertion order
inside a `code_anchors` item (`pattern`, then `enforcement`), while Foundation's
generic canonical mapping rule emits binary order (`enforcement`, then
`pattern`). Foundation output enforcement takes precedence over donor byte
parity; no consumer field receives a privileged ordering rule.

The exact temporary-output operator is
`documentTemporaryPath(destination, planDigest)`. It places a sibling named
`.foundation-document-<digest>.tmp`, where `<digest>` is the 64 lowercase hex
characters from the canonical `sha256:` Plan digest. The basename is 89 ASCII
bytes. Planning fails closed unless the sibling remains within the 512-byte
repository-path and 255-byte segment budgets; a root destination produces a
root temporary path without `./`. The transaction slot accepts only this
derived path. Its creator handle records exact Node-filesystem identity
`{adapter:"node-filesystem",version:1,dev,ino,birthtimeNs}` using canonical
unsigned decimal identity strings. A zero field records that the adapter cannot
provide recovery authority on that filesystem: the evidence is preserved for
manual recovery and must never authorize publication or cleanup. Otherwise,
recovery requires an exact physical identity match;
unverifiable or unsupported identity remains manual-recovery-only.

## Canonical digest preimages

Canonical JSON requires strings and keys to already be NFC, accepts only the
JSON data model and safe integers, preserves array order, binary-sorts object
keys, and emits no insignificant whitespace. Canonical document JSON rejects
negative zero and lone UTF-16 surrogate code units in keys or values; JSON
Schema validation alone is not authority for either invariant. Every
document-owned digest hashes
UTF-8 canonical JSON of the wrapper `{domain,payload}` using SHA-256:

| Evidence | Exact domain | Payload |
| --- | --- | --- |
| Intent | `agent-teams.foundation.document-authoring/intent/v1` | canonical Intent |
| Owner membership | `agent-teams.foundation.document-authoring/owner-membership/v1` | `{ownerCatalogDigest,ownerId}` |
| Identity projection | `agent-teams.foundation.document-authoring/identity-projection/v1` | `{entries:[{id,repositoryPath}]}` with entries sorted by ID then path |
| Referenced document | `agent-teams.foundation.document-authoring/referenced-document/v1` | exact wire `{id,path}` |
| Plan | `agent-teams.foundation.document-authoring/plan/v1` | complete Plan omitting only `planDigest` |
| Receipt | `agent-teams.foundation.document-authoring/receipt/v1` | complete Receipt omitting only `receiptDigest` |

The identity projection's `entryCount` equals the number of entries used in its
payload. Authority source digests and output content digests remain raw SHA-256
of exact bytes. Transaction `payloadDigest` and `envelopeDigest` retain their
existing envelope contract and are not reinterpreted by this domain separator.

## Compiler and logical preimage

Compilation is a pure operation over one canonical Intent and recaptured
consumer authorities. It must reject before Plan construction when:

- the catalog is `partial`, a bounded observation was truncated, or either
  observation pass changed;
- an ID, normalized path, owner, reference, artifact type, identity grammar,
  placement, parent, template, or final metadata instance is invalid;
- any authority exceeds its budget or cannot be strictly decoded;
- destination classification is conflict rather than absent or the exact
  planned logical self.

Read-only discovery may return bounded partial results; authoring may not use a
partial catalog as allocation authority. The minimal identity preimage contains
only exact `{id,repositoryPath}` entries and is binary-sorted by ID then path.
Referenced-document evidence is emitted only for IDs actually used by the
Intent.

For replay or recovery, the planned destination is excluded from the rebuilt
logical identity preimage only if that exact repository path contains the exact
planned output bytes and the document's parsed ID exactly equals the planned
ID. The original Plan must then reproduce byte-for-byte. Matching bytes at a
different path, matching ID in a different file, conflicting bytes, invalid
frontmatter, or any second ID/path collision remains a conflict. This is the
only existing-exact self exception; it is not a general overwrite or adoption
rule.

## Transaction and compatibility

One repository root has one canonical Foundation operation lock and one active
transaction slot. Directory materialization uses envelope v4 with registered
recovery-handler contract v3 and `document-authoring-journal/v3`. It records
the exact Foundation version/build, adapter contract, Plan v2, materialization
evidence, payload digest, lifecycle state, and envelope digest. Envelope v3
remains the exact legacy file-only protocol.
The canonical lock is a bounded owner-token regular file. New ownership is
published with no replacement, and reclaim or release is fenced by token plus
physical file identity. A same-host lock is reclaimed only when its PID is
provably dead on a single-host/local filesystem; foreign or ambiguous liveness
fails closed. A takeover claim is exclusive and is never automatically
reclaimed: partial or stale claim evidence for the current lock generation
requires manual recovery because portable Node APIs do not provide
unlink-if-identity CAS. Claims are keyed by the observed lock token, making
cleanup residue from an older generation inert. Partial canonical or current
generation claim writes likewise remain regular-file manual-recovery barriers. If transaction
evidence remains, release retains that same regular-file inode as a durable
transaction barrier. This intentionally makes released directory-lock clients
fail closed before they can mutate. Interrupted in-place ownership/barrier
rewrites also remain regular-file evidence and require recovery rather than
opening an unlocked window.
The coordinator enforces that barrier for scaffolding, document authoring, and
local attach or detach before mutation begins. It recognizes the frozen legacy
scaffolding journal v1 and immutable document envelopes v2, v3, and v4 at the
historical physical slot; an orphan temporary, invalid regular-file evidence,
unknown schema, digest failure, or contradictory document lifecycle is
preserved and fails closed.
Incomplete local-mode phases and orphan registry backups share the same
coordinator and admit only `detach`. Status reports a structured recovery route
only for an implemented path: legacy `scaffold-recover`, local-mode `detach`, or
`docs-recover` for an exact compatible envelope v3 or v4 handler. Envelope v2 and
document journal v1 are permanently manual-recovery-only in current packages.
The legacy local-mode `FoundationTransactionStatus` projection remains
type-compatible and intentionally lossy for document envelopes v3 and v4: it reports
`recovery-handler-unavailable` and does not expose `docs-recover`. Automation
that routes document recovery must use the versioned
`inspectDocumentTransactionV2` API from `./document-authoring`; V1 retains its
frozen projection while V2 exposes exact v3 and v4 evidence.

For envelopes v3 and v4, the recorded package-artifact identity contains SemVer plus a
canonical SHA-256 digest of the installed package manifest, executable
JavaScript, and shipped schema and preset contracts. The digest is independent
of install path and directory enumeration order, is cached for the immutable
installed package process, and distinguishes rebuilt shipped artifacts at the
same version. Recovery is available only from the exact recorded SemVer and
build identity through the closed v2 handler after its required dependency
closure and adapter semantics are qualified. The envelope Foundation identity
must equal the embedded document compiler version and build identity. A version
range, same-version rebuild, or merely schema-compatible package is not recovery
authority.

The journal v3 lifecycle is closed:

| Envelope state | Destination state | Additional evidence | Authority |
| --- | --- | --- | --- |
| `PREPARED` | `pending` or `preexisting` | Anchor identity; zero created directories; no pending directory, temporary, or publication identity | May continue only after exact Plan and anchor recapture |
| `MATERIALIZING` | `pending` | Exact ordered created-directory identity prefix; optional one pending unbound directory; no temporary or publication identity | May create/bind only the next planned segment; an unbound mkdir crash is manual |
| `PUBLISHING` | `publishing` | Complete directory identity prefix and exact Plan-derived temporary with non-zero creator identity | May publish only after every directory, authority, and absence precondition is recaptured |
| `PUBLISHED` | `published` | Complete directory identity prefix; non-zero destination `publicationIdentity`; no temporary | May finalize only when destination and every bound directory remain exact |

A zero component in a PUBLISHING temporary identity is valid preserved wire
evidence, but provides no publication or cleanup authority. A PUBLISHED journal
cannot contain zero publication identity. Missing, substituted, same-byte but
different-identity, or otherwise ambiguous evidence requires manual recovery.

Publication proceeds only after durable PREPARED and PUBLISHING evidence. The
writer rechecks authority, real-directory ancestry, destination absence,
temporary identity, bytes, and mode immediately before create-no-replace. After
publication it verifies destination bytes, mode, non-zero identity, and
same-file relationship, syncs the parent, removes only the identity-matched
temporary, records PUBLISHED durably, then removes the identity-fenced journal
and emits the Receipt. A crash at any boundary either leaves sufficient exact
v3/v4 evidence for the exact handler or produces manual-recovery evidence; it does
not authorize rollback of a possibly published destination.

Directory cleanup is deliberately unsupported by the portable Node adapter.
Cancellation or a prepublication failure may remove an identity-bound owned
temporary, but retains all transaction-created directories. Immediately before
journal removal and Receipt creation, every bound directory identity is
recaptured. Missing, replaced, non-directory, symlinked, aliased, non-prefix,
or otherwise unproven evidence keeps the journal and emits manual recovery with
`preserved-unknown`; it is never reported as `created-and-retained`. Receipt v2
therefore has only `none-created`, `created-and-retained`, and
`preserved-unknown` directory states.

Cancellation returns `cancelled` only before publication when destination
absence is proven and every owned temporary and journal has been durably
removed. Once publication has occurred or is ambiguous, cancellation is masked:
the writer completes a provable commit or preserves evidence. It never reports
cancelled while a transaction or possible output remains.

The envelope does not merge `ScaffoldPlan` with `DocumentPlan` or their
Receipts. Recovery dispatch is closed in the Foundation composition root and
cannot call consumer code. A current Foundation package reads the legacy
scaffolding journal, envelope v2, envelope v3, and envelope v4. Only envelope
v3/v4 with the exact recorded Foundation version and build identity may select `docs-recover`.
Envelope v2 is preserved as manual-recovery evidence. Packages older than v3
preserve its unknown regular-file slot and block mutation. Unknown, newer,
tampered, or multiple transaction evidence is likewise preserved. Journals are
never migrated, rewritten, downgraded, or automatically deleted.

Recognition of envelope v2 and journal v1 cannot be retired until governed
inventory proves zero instances in every admitted repository, all producing
writers are retired from supported package policy, a complete support window
has elapsed after that retirement, and a new accepted ADR identifies the
removal release and audit evidence. The same inventory, producer-retirement,
support-window, recovery-fixture, and ADR gates apply before a v3 or v4 handler can be
retired. Exact recorded registry artifacts remain recovery authority while any
active transaction produced by them can still be supported.

### Apply-time physical recapture

The compiler's expected parent is logical portable evidence, not a durable
filesystem handle. Apply and recovery therefore recapture the repository root,
destination parent, and every ancestor under the shared operation lock. The
deepest planned anchor and every bound created segment must still exist, be a
directory, retain its physical identity, and consist only of real directories.
A symlink, junction, reparse point, replacement, normalization/case alias,
containment escape, unsupported observation, or any difference from the Plan's
logical expectation yields stale authority, conflict, or manual recovery as
appropriate; publication does not proceed. A portable Plan never claims that a
stored inode/device tuple remains valid across platforms or process lifetimes.

## Atomicity vocabulary

| Term | Exact claim |
| --- | --- |
| `not-published` | No destination publication was observed by this operation |
| `preexisting-exact` | Exact desired bytes already existed and were not published by this operation |
| `single-file-atomic-create` | One absent destination was published without replacement on a qualified adapter |
| `journaled-recoverable` | Durable transaction evidence permits compatible recovery; it is not a multi-file transaction claim |
| `preserved-for-recovery` | Evidence or output may exist and was intentionally retained for recovery or manual resolution |

After the first publication boundary, Foundation never automatically deletes a
destination. Allowed actions are complete, preserve, recover, or request manual
resolution. See the [cooperative writer threat model](../security/document-authoring-threat-model.md)
for the exact safety claim.

## Versioning and non-goals

Schema version identifies shape; protocol version identifies semantics;
compiler version and build identity identify the released implementation;
adapter contract version identifies observable filesystem postconditions. An
unknown schema, protocol, handler, or newer journal fails closed.

This version does not provide automatic sequence allocation, directory rollback,
managed reachability, generic Markdown updates, persistent indexing, fuzzy or
semantic search, a documentation portal, a polyglot binary, organization-wide
policy, or a generic consumer mutation API. The current transaction and
recovery semantics are accepted by ADR-0024. ADR-0023 remains normative for the
corrected Intent, Plan, Receipt, and compiler v1 contracts; ADR-0022 is retained
only as superseded historical evidence.
