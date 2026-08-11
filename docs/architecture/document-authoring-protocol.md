# Document Authoring Protocol

Status: Contract-only target accepted by ADR-0022. Read-only catalog, compiler,
writer, CLI commands, transaction coordinator, and recovery handlers are not yet
implemented or available to consumers.

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
| Allowed metadata shape | Consumer metadata schema | Validate the compiled instance |
| Create-enabled document types | Consumer authoring profile | Select one closed v1 strategy |
| Initial status and creation defaults | Consumer authoring profile | Apply and validate them |
| Allowed owner identifiers | Consumer owner catalog | Prove exact membership |
| Meaning of an owner identifier | Consumer domain | Keep it opaque |
| Path reviewers | Consumer `CODEOWNERS` | No interpretation |
| Body structure | Consumer body template | Read bounded local bytes |
| Current identifiers and paths | Rebuilt document catalog | Detect duplicate identity or path |
| Relations and blockers | Document frontmatter | Preserve bounded data |
| Blocker and code-anchor semantics | Consumer validator | No generic interpretation |
| Generic links and anchors | Foundation documentation checks | Validate read-only integrity |
| Safe file publication | Foundation authoring protocol | Enforce Plan and adapter contract |
| Transaction coordination | Private Foundation coordinator | Serialize Foundation mutations |
| Agent routing | Existing `repository.agent-workflow` | Validate the declared route |
| Prose and diagram tools | Consumer exact lockfile and checks | Never execute them from a profile |
| Organization requirements and exceptions | Central policy repository | Outside this protocol |
| Portal and search presentation | Rebuildable derived system | Never write canonical sources |

The metadata schema answers which final document is valid. The authoring profile
answers which initial document may be created. They are intentionally separate.
Foundation does not infer creation defaults from arbitrary JSON Schema.

## Published language

### Document intent v1

An Intent contains an explicit document type, identity, title, owner, summary,
related identifiers, and bounded inert additional metadata. Foundation does not
interpret consumer relationship or lifecycle semantics. Foundation-owned sets
use binary ordering; consumer-owned ordered arrays retain their input order.

### Document plan v1

A Plan binds the exact compiler version and build identity, canonical Intent and
digest, project identity, profile and metadata schema evidence, selected owner,
template, minimal identity projection, used document references, logical parent
expectation, destination, absent-file precondition, exact output bytes, adapter
capabilities, diagnostics, and Plan digest.

A Plan never contains an absolute path, timestamp, process identifier, locale,
environment value, arbitrary executable configuration, or an unbounded corpus.
Its parent expectation is repository-logical evidence. The filesystem adapter
must still recapture physical ancestry under the operation lock.

### Document receipt v1

A Receipt reports only observed facts: Plan digest, adapter contract,
destination, outcome, optional proven result digest, commit observation, stable
diagnostics, and Receipt digest. It does not prove semantic completeness,
evidence quality, related-document updates, architectural acceptance, or
consumer check success.

### JSON command envelope v1

Machine mode emits exactly one bounded JSON object with a stable command,
outcome, structured diagnostics, and command-specific result. Human text never
shares stdout. Paths always use `/`, zero search matches are success, and
timestamps or durations are excluded. Remediation is a command identifier plus
bounded arguments, not a preformatted shell command.

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
- template: one bounded local UTF-8 Markdown body without frontmatter, H1,
  includes, interpolation, or executable expressions.

It prohibits automatic identity allocation, arbitrary regular expressions or
globs, commands, callbacks, hooks, dynamic imports, environment interpolation,
remote templates or schema references, inheritance, conditional rules,
directory creation, updates, deletion, free-form index editing, and arbitrary
filesystem paths.

Destination parents must already exist and be real directories. Paths use a
portable ASCII grammar with no absolute form, `..`, backslash, control, trailing
dot or space, NTFS alternate stream, or Windows device component. Output is
UTF-8 with LF, one terminal newline, and logical mode `0644`.

## Transaction and compatibility

One repository root has one canonical Foundation operation lock and one active
transaction slot. A version 2 envelope records operation kind, registered
recovery handler, exact Foundation version and build identity, adapter contract,
protocol payload kind and journal, payload digest, state, and envelope digest.

The envelope does not merge `ScaffoldPlan` with `DocumentPlan` or their
Receipts. Recovery dispatch is closed in the Foundation composition root and
cannot call consumer code. A compatible Foundation version may read the legacy
scaffolding journal and the version 2 envelope. Unknown, newer, tampered, or
multiple transaction evidence is preserved and blocks mutation. Journals are
never migrated automatically.

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

This version does not provide automatic sequence allocation, directory creation,
managed reachability, generic Markdown updates, persistent indexing, fuzzy or
semantic search, a documentation portal, a polyglot binary, organization-wide
policy, or a generic consumer mutation API.
