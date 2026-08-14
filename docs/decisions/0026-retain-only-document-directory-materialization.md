---
id: ADR-0026
status: accepted
supersedes:
  - ADR-0025
superseded_by: []
---

# ADR-0026: Retain-Only Document Directory Materialization

Status: Accepted

Date: 2026-08-14

Decision owner: Product owner

## Context

ADR-0025 introduced unified documentation authoring and allowed Foundation to
materialize Plan-bound parent directories. Its rollback wording assumed that a
portable Node adapter could safely remove an empty directory after proving that
the transaction created it. Node does not expose identity-conditional `rmdir`;
a same-OS-user process can replace a pathname between proof and deletion.
Deletion would therefore exceed the protocol's honest filesystem guarantee.

This decision supersedes ADR-0025 so its unsafe rollback wording cannot remain
normative. It carries every unaffected ADR-0025 decision forward and replaces
only its directory-materialization and recovery semantics. ADR-0024's envelope
v3 and journal v2 remain immutable exact-version recovery evidence.

## Carried-forward ADR-0025 decisions

The following decisions remain normative without semantic change:

1. Foundation and Docs Protocol remain independently versioned packages in one
   monorepo with dependency direction Docs Protocol -> Foundation.
2. Foundation owns the closed mutation mechanism and inert contracts; Docs
   Protocol owns documentation orchestration, query semantics, diagnostics,
   and the uniform agent command vocabulary.
3. Foundation authoring profile v2 remains the sole authority for project
   vocabulary, document types, owners, placement, identity, and reachability.
4. Consumer authority remains bounded inert local data. Executable hooks,
   remote schemas, environment interpolation, and arbitrary templates remain
   forbidden.
5. Preview remains non-mutating and non-reserving; mutation requires explicit
   apply. Index updates remain explicit consumer-authorized actions.
6. Strict sidecars may supply metadata for frozen Markdown but cannot promote
   evidence or change authority; conflicting overlaps and orphans fail closed.
7. Existing Markdown/YAML remain canonical while schema, lint, spelling, and
   diagram tools remain specialized validators or renderers.
8. Consumer cutover remains parity-first with golden fixtures, packed-registry
   qualification, exact pins, and no dual writer after adoption.
9. Release qualification still covers deterministic tarballs, public exports,
   CLI startup, hermetic registry installation, version skew, package contents,
   lock integrity, and supported operating systems using disposable fixtures.
10. Docs Protocol public API bootstrap remains limited to its first declared
    release and uses create-no-replace baseline publication.
11. The release sequence and Changesets ownership defined by ADR-0025 remain
    unchanged; versions and prerelease state are never edited by hand.

## Decision

1. Foundation adds Document Plan v2, Document Receipt v2, transaction envelope
   v4, document journal v3, and recovery-handler contract v3. These are additive
   contracts. The exported v1 `DocumentPlan` interface, `DocumentReceipt` alias,
   Intent, envelope v2/v3, journals v1/v2, and their meanings do not change.
2. Plan v2 binds the deepest existing real-directory anchor and exact ordered
   missing segments. It also binds the profile semantic digest and both the
   catalog preimage and expected postimage semantic digests. Replaying after the
   Plan's own exact publication reproduces the Plan; unrelated authority drift
   fails closed.
3. Envelope v4 has the closed lifecycle `PREPARED -> MATERIALIZING -> PUBLISHING
   -> PUBLISHED`. The journal records the anchor identity, exact ordered prefix
   of created-directory identities, at most one pending unbound segment, owned
   temporary identity, and final publication identity as applicable.
4. Portable Node directory recovery is retain-only. Foundation never calls
   `rmdir` or recursively deletes a directory created by this protocol. A
   cancellation or prepublication failure may remove only an identity-bound
   owned temporary; created directories remain repository state.
5. Immediately before journal removal and Receipt creation, Foundation
   recaptures the anchor and every bound directory. Exact retained evidence is
   reported as `created-and-retained`; no creation is `none-created`. Missing,
   replaced, aliased, non-directory, non-prefix, or otherwise unproven evidence
   retains the journal and reports manual recovery with `preserved-unknown`.
   Receipt v2 has no `rolled-back` state.
6. Publication and recovery mutate only paths derived from a final verified
   root/ancestry recapture. Realpath resolution is followed by lstat identity
   binding, including the parent identity. Temporary retirement re-proves the
   original source path absent before completion and syncs the destination
   evidence root before its source parent.
7. The threat boundary excludes a hostile process running as the same OS user.
   Portable Node cannot make `mkdir -> lstat`, `realpath -> lstat`, `open`, or
   `link` one identity-fenced syscall. Observable swaps fail closed and retain
   evidence, but an undetectable same-user race may cause a bounded side effect
   before rejection. The protocol does not claim a hostile-writer sandbox.
8. Recovery uses only the exact recorded Foundation version/build and matching
   handler generation. Unknown, newer, tampered, incomplete, or contradictory
   evidence is preserved; journals are never migrated or reinterpreted.

## Consequences

- Directory materialization is deterministic and crash-recoverable without an
  unsafe deletion claim.
- Failed writes can leave empty or user-populated directories, which is safer
  than deleting a pathname whose current identity cannot be atomically fenced.
- V1 consumers retain their exact public type identities and wire semantics;
  v2 consumers opt into separately named additive contracts and entrypoints.
- The exact lifecycle and crash matrix remain normative in the Document
  Authoring Protocol; security claims remain bounded by the threat model.
