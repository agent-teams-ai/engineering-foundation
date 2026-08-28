---
id: ADR-0039
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0039: Open-Source Documentation Protocol

Status: Accepted

Date: 2026-08-28

Decision owner: Product owner

## Context

Docs Protocol already provides deterministic document discovery, create-only
authoring, validation, recovery, and managed Agent Teams adoption. An
open-source repository needs a smaller self-service path: install an exact
package version, bootstrap inert local authority, search and author Markdown,
build bounded agent context, and optionally expose the same read-only behavior
over MCP. That path must not require the Agent Teams managed Cohort, a hosted
service, a documentation portal, or executable consumer extensions.

The new surface adds several reasons to change: canonical document semantics,
repository observation and mutation, derived search/context projections, CLI
presentation, and an optional transport. Combining those responsibilities in a
second product or daemon would duplicate authority and recovery behavior.
Putting transport, search caches, commands, or external tools into a consumer
profile would instead turn inert data into an extension runtime.

## Decision

1. `@agent-teams/docs-protocol` remains one modular monolith over the mutation
   and catalog mechanisms owned by `@agent-teams/engineering-foundation`.
   Internal modules own bootstrap, catalog/search, context projection,
   authoring, checking, and presentation behind explicit application ports.
   They share canonical contracts and one composition root; they do not read
   one another's adapter state or create parallel writers.
2. The public CLI adds an open-source workflow consisting of `init`, `find`,
   `context`, `new`, and `check`. CLI parsing and rendering remain adapters.
   Application behavior is callable without a terminal, and machine envelopes
   remain the stable automation boundary.
3. MCP is optional and, if shipped, is a separately versioned package with a
   one-way dependency on Docs Protocol's public application API. The MCP
   package is a transport adapter only: it owns no catalog, profile semantics,
   search index, mutation behavior, recovery authority, or canonical content.
   Installing the CLI package never installs or starts an MCP server.
4. Docs Protocol profile v3 is an additive portable profile that references
   Foundation document-authoring profile v3. Existing Docs Protocol v1/v2 and
   Foundation authoring v1/v2/v3 authorities retain their meanings. Unknown
   fields continue to fail closed, and a portable consumer opts into the new
   profile shape explicitly.
5. The Agent Teams managed preset, its daily command behavior, and its managed
   Cohort integration remain unchanged. Portable bootstrap does not enroll a
   repository, synthesize managed state, modify protected workflow authority,
   or weaken the managed qualification gates.
6. Repository-owned Markdown and YAML are the only canonical documentation and
   configuration authorities. A rebuilt catalog, ranked-search index, context
   bundle, `llms.txt`-style projection, or other generated representation is a
   disposable derivative. It cannot allocate identity, satisfy authoring
   preconditions, override metadata, or become recovery authority. Every
   command rebuilds or verifies the authority required for its result.
7. `find` may use MiniSearch ranking. Ranking is advisory: it affects result
   order and similarity hints only. Exact identity, path collision, metadata,
   reachability, and write decisions are computed from the canonical catalog,
   never from a MiniSearch index or score. Zero matches remain success and
   deterministic tie-breaking uses canonical document identity and path.
8. `context` emits bounded, deterministic projections from a freshly observed
   catalog. Selection criteria, budgets, truncation, source identities, and
   diagnostics are explicit in machine output. A context projection is not a
   document, index, acceptance decision, or evidence that omitted sources do
   not exist.
9. `init --dry-run` is non-mutating and non-reserving. `init --apply` must
   reproduce the reviewed Plan under the repository-wide Foundation operation
   barrier. Its closed write set contains only create-absent files and
   exact-preimage replacements; each existing byte sequence, mode, path, and
   relevant authority digest is Plan-bound. A changed, unexpected, aliased, or
   unsupported preimage fails closed. There is no force, wildcard ownership,
   delete, rename, arbitrary merge, package-manager subprocess, lifecycle
   script, or unjournaled fallback.
10. Bootstrap writes only the minimum repository-owned Markdown/YAML authority,
    templates, local authoring Skill, and one marker-bounded agent instruction.
    Package installation and repository scripts remain explicit user-owned
    steps; bootstrap does not edit a manifest or lockfile. Recovery uses the
    exact compatible Foundation build and persisted transaction evidence;
    ambiguous state is preserved for manual recovery.
11. Data profiles cannot contain executable consumer plugins, module or package
    references, commands, arguments, callbacks, hooks, dynamic imports,
    environment interpolation, remote schemas, or template engines. Optional
    capabilities are selected only from package-owned closed identifiers.
12. Vale and Lychee remain external adapters owned by explicit operator or CI
    configuration. Profiles may describe inert policy or expected evidence only
    where a versioned schema admits it; loading, searching, authoring,
    contextualizing, or checking a profile never launches Vale, Lychee, a shell,
    a package manager, or any other external program.
13. This decision selects no documentation site generator, portal, hosted
    search UI, daemon, or synchronization service. Human-readable Markdown in
    the repository remains sufficient to adopt the protocol.
14. Runtime compatibility remains the package's current qualified Node contract
    (`>=24.18.0 <25`). The initial portable release qualifies exact installation
    with npm and pnpm only. Yarn, Bun, broader Node versions, Bun as the runtime,
    or another execution environment require separate compatibility,
    packed-consumer, binary-startup, recovery, and cross-platform evidence before
    support is claimed.

## Security and failure behavior

- All selected paths are bounded repository-relative portable paths. Traversal,
  absolute paths, symlinked authority, case/NFC aliases, special files, and
  containment ambiguity fail closed.
- Input, catalog, search, context, diagnostic, and encoded-output budgets are
  explicit. Malformed UTF-8, NUL data, duplicate identities, partial catalogs,
  and authority drift cannot be used for authoring or bootstrap.
- Search and context treat document bodies as untrusted content. They never
  interpret prose as configuration or instructions and never interpolate it
  into commands.
- Apply can expose the bounded mixed-state window already documented for
  recoverable known-file transactions. It never claims multi-file atomicity or
  protection from a hostile same-OS-user writer. Exact-build recovery completes
  or conditionally restores only identity-bound transaction state.
- MCP, when present, inherits the same bounded application envelopes. Network
  exposure, authentication, authorization, multi-tenant hosting, and remote
  mutation are outside this decision and remain disabled unless separately
  designed and qualified.

## Compatibility and rollout

The portable profile and commands are additive. Existing managed consumers do
not migrate automatically, and their profile digests and generated assets are
not rewritten. A portable repository may remove generated search/context
artifacts and rebuild them from Markdown/YAML without information loss.

Rollback before apply is to discard the Plan. After a successful bootstrap,
rollback is an explicit source change reviewed like any other repository
change; the protocol does not silently delete initialized files. After an
interrupted apply, the exact recorded build runs recovery before package changes
or another Foundation mutation. Unknown or contradictory evidence remains a
manual-recovery barrier.

Publication requires deterministic package contents, exact-version installation
through the hermetic npm-compatible registry, CLI and optional MCP startup from
packed artifacts, positive and adversarial disposable fixtures, and supported
OS evidence. Package-manager command examples do not broaden the qualified Node
runtime. Until that evidence and implementation land, community commands are
target behavior rather than an availability claim.

## Consequences

- Open-source users get one repository-native workflow without adopting Agent
  Teams managed governance.
- Canonical semantics stay in one modular monolith while optional MCP can evolve
  without creating a second domain implementation.
- Derived ranking and context are cheap to rebuild and cannot silently replace
  reviewable Markdown/YAML authority.
- Exact-preimage bootstrap is more conservative than a best-effort initializer;
  concurrent edits require a fresh preview instead of an implicit merge.
- Supporting another package manager adds packed-consumer and binary-startup
  qualification work but does not by itself broaden the runtime claim.

## Non-goals

- A documentation website, portal, visual search product, or hosted service.
- Executable profile plugins, arbitrary commands, or consumer callbacks.
- Automatic execution of Vale, Lychee, or consumer validation commands.
- Semantic acceptance of prose, automatic architecture approval, or automatic
  repair of documents.
- Automatic managed-Cohort enrollment or replacement of the Agent Teams preset.
- A persistent authoritative index, embedding database, or remote vector store.
- Broader Node or alternative-runtime support without separate qualification.

## Rejected alternatives

- Build a second standalone open-source documentation product with its own
  catalog and writer.
- Put MCP transport and lifecycle inside the required CLI package.
- Treat MiniSearch or generated context as canonical authority.
- Encode npm scripts, Vale, Lychee, or arbitrary plugins in a data profile.
- Select a site generator or portal as part of the first community slice.
- Bootstrap through unbounded text merges or overwrite-on-conflict behavior.
