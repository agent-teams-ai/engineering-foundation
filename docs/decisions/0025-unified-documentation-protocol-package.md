---
id: ADR-0025
status: superseded
supersedes: []
superseded_by:
  - ADR-0026
---

# ADR-0025: Separate Unified Documentation Protocol Package

Status: Accepted

Date: 2026-08-14

Decision owner: Product owner

## Context

Foundation already contains the generic transaction coordinator, portable path
policy, catalog observation, deterministic Plan compiler, create-no-replace
publication, Receipt evidence, and exact-build recovery. Consumers nevertheless
expose different document commands and metadata conventions. Moving all of that
meaning into Foundation would couple the reusable mutation kernel to one domain;
leaving every consumer to assemble its own CLI would preserve drift and duplicate
the most failure-prone authoring behavior.

The existing document-authoring v1 wire contracts and published transaction
evidence cannot be reinterpreted. The next protocol must preserve their recovery
boundary while adding directory materialization and a uniform agent workflow.

## Decision

1. This monorepo publishes two independently versioned packages with separate
   package boundaries. `@agent-teams/engineering-foundation` owns generic
   mutation mechanisms. `@agent-teams/docs-protocol` owns documentation-specific
   orchestration and user experience.
2. Dependency direction is one-way:
   `@agent-teams/docs-protocol -> @agent-teams/engineering-foundation`.
   Foundation never imports or depends on Docs Protocol. Workspace declaration,
   source-boundary, public API, package, and registry gates enforce this rule.
3. Foundation owns catalog primitives, the closed `Intent -> Plan -> Apply ->
   Receipt` kernel, one cooperative mutation lock, durable publication,
   transaction inspection, exact-build recovery, and portable filesystem
   invariants. It exports mechanisms, not a consumer-programmable mutation
   framework.
4. Foundation authoring profile v2 is the sole authority for the document type
   catalog, project vocabulary, placement and identity rules, authoring policy,
   and reachability policy. Docs Protocol owns the uniform `docs:info`, `docs:find`, `docs:new`,
   `docs:doctor`, `docs:recover`, and `docs:check` behavior; the common metadata
   vocabulary; relationships, blockers, and code anchors; query semantics;
   authoring diagnostics; and the short agent workflow.
   Its minimal local configuration only references the Foundation profile and
   contains Docs Protocol-specific presentation settings; it never duplicates
   document types, project vocabulary, authoring rules, or reachability rules.
5. Every consumer owns one strict Foundation local data profile: project identity, document
   types, identity and placement strategy, owners, local metadata schema,
   templates, explicit reachability policy, and semantic validators executed by
   its normal repository check. A missing reachability decision is invalid; it
   is never treated as `not-required`.
6. Consumer authority is inert local data. Profiles and referenced schemas are
   bounded repository files. JavaScript hooks, callbacks, YAML commands, remote
   schemas, environment interpolation, arbitrary template execution, and
   consumer code inside either shared package are forbidden.
7. Preview is non-mutating and non-reserving. Writes occur only with explicit
   `--apply`. Indexes are never edited automatically; the result emits the exact
   consumer-authorized `indexPath` and relative Markdown link when manual
   reachability is required.
8. Foundation vNext may create missing allowed parent directories as part of the
   same transaction. The exact missing directory segments are bound into the
   Plan and persisted journal. Recovery and rollback may remove only directories
   proven to have been created by that transaction and only while empty. They
   never remove pre-existing, unowned, replaced, or non-empty directories.
   Receipt v2 reports the truthful directory outcome: planned segments,
   observed created segments, and whether those segments were retained, rolled
   back, absent, or preserved because their state could not be proven.
9. Byte-frozen or externally controlled Markdown may use one strict metadata
   sidecar. A document either has complete inline metadata, or its partial inline
   metadata is merged with the sidecar entry. Equal overlapping values are
   accepted; conflicting overlaps and orphan sidecar entries fail closed. The
   merged result must satisfy the same metadata schema and evidence bindings as
   inline metadata. A sidecar supplies metadata only: it cannot promote a source
   to evidence, historical authority, or any stronger authority class.
10. Published document Intent, Plan, Receipt, envelope v2/v3, and journal v1/v2
   contracts retain their existing meanings. VNext uses separately versioned
   schemas and recovery handlers. Legacy evidence remains fail-closed and routed
   only to its exact compatible recovery implementation.
11. Existing Markdown and YAML sources remain canonical. JSON Schema,
    markdownlint, Vale, CSpell, Mermaid, and LikeC4 remain specialized validation
    or rendering tools. No documentation site generator, portal, persistent
    index, or visual search product is selected by this decision.
12. Cutover is parity-first. A consumer deletes its legacy writer or query only
    after positive and negative golden fixtures prove the unified command
    semantics, packed-registry qualification passes, exact versions are pinned,
    and the consumer's complete check is green. Dual write engines are forbidden
    after cutover.
13. Release qualification covers deterministic tarballs, public exports, CLI
    startup, exact dependency installation from a hermetic registry, lockfile
    integrity, package contents, version skew, and Linux, macOS, and Windows.
    Mutation tests use disposable fixtures only.
14. Docs Protocol bootstraps its first public API baseline only while its exact
    package version is `0.0.0` and a minor or major Changeset declares the first
    release. Foundation extracts the real declaration surface and publishes the
    baseline with create-no-replace semantics. A missing baseline at any later
    version, invalid evidence, or a concurrent path conflict fails closed.

## Release sequence

The active Foundation 0.16 release-candidate wave is completed and exited before
this feature starts a new prerelease wave. After stable Foundation 0.16.0, the
feature is rebased, Changesets enters a fresh `rc` wave, and the normal minor
changesets produce Foundation 0.17.0-rc.0 and Docs Protocol 0.1.0-rc.0. Neither
manifest version nor `.changeset/pre.json` is edited by hand.

## Consequences

- Agents learn one small command vocabulary while each repository keeps its own
  domain language and document topology.
- Foundation stays reusable and independently testable; Docs Protocol can evolve
  its documentation UX without turning the kernel into a plugin host.
- The second package adds release-graph and version-skew complexity, so every
  publication and generated release PR must be attested as a multi-package wave.
- Consumers retain semantic validation responsibility; a successful shared
  protocol check does not claim that consumer prose or domain rules are correct.

## Rejected alternatives

- Keep independent consumer CLIs and share only prose guidance.
- Put the unified documentation CLI back inside Foundation.
- Expose executable consumer plugins or a generic mutation callback API.
- Automatically update Markdown indexes.
- Correct or reinterpret published v1 transaction evidence in place.
- Publish from the active 0.16 prerelease state and accept accidental versions.
