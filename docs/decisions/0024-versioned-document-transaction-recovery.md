---
id: ADR-0024
status: accepted
supersedes:
  - ADR-0023
superseded_by: []
---

# ADR-0024: Versioned Document Transaction Recovery

Status: Accepted

Date: 2026-08-13

Decision owner: Product owner

## Context

ADR-0023 corrected the pre-adoption document Intent, Plan, and Receipt v1
contracts. It also retained the already published Foundation transaction
envelope v2 and document journal v1 as the intended writer boundary. Independent
writer review found that this persisted shape cannot prove safe completion after
publication: its `PUBLISHED` state does not bind the destination's physical
identity. Matching bytes alone cannot distinguish the file published by
Foundation from a same-byte replacement by a noncooperating writer.

The envelope v2 and journal v1 shapes are present in immutable npm artifacts and
may exist as persisted repository evidence. They therefore satisfy ADR-0019's
real migration-boundary requirement and cannot be corrected in place. Treating
them as a new meaning would make recovery depend on the inspecting package
rather than on the contract that created the evidence.

This decision supersedes ADR-0023 only for transaction-envelope, journal, and
recovery semantics. ADR-0023's corrected Intent v1, Plan v1, Receipt v1,
compiler, path, digest, authority, and resource-limit decisions remain
normative. ADR-0019 and all security hardening it preserves remain active.

## Decision

1. The published Foundation transaction envelope v2, document-authoring journal
   v1, and recovery-handler contract v1 are immutable, evidence-only formats.
   Current packages recognize and preserve them, report manual recovery, and
   block every Foundation mutation. They never resume, publish, clean up, or
   reinterpret that evidence.
2. The document writer persists Foundation transaction envelope v3 containing
   `document-authoring-journal/v2` and the closed
   `foundation.document-authoring` recovery-handler contract v2. Envelope v3
   remains at the historical single transaction slot and retains closed schema,
   payload-digest, envelope-digest, operation-kind, Foundation identity, and
   adapter-contract bindings.
3. Journal v2 uses a closed lifecycle matrix:
   - `PREPARED` binds the exact Plan and a `pending` or `preexisting`
     destination, with neither owned temporary nor publication identity;
   - `PUBLISHING` binds a `publishing` destination and exactly one
     Plan-derived owned temporary with its output digest and creator-handle
     physical identity;
   - `PUBLISHED` binds a `published` destination and its non-zero
     `publicationIdentity`, and forbids an owned temporary.
   Contradictory fields or lifecycle combinations are invalid evidence and
   manual-recovery-only.
4. A physical identity is the closed Node filesystem tuple
   `{adapter:"node-filesystem",version:1,dev,ino,birthtimeNs}`. A zero component
   remains valid wire evidence that identity was unavailable. A PUBLISHING
   journal containing such a temporary is preserved for manual recovery and
   authorizes neither publication nor cleanup. A PUBLISHED journal requires a
   fully non-zero publication identity.
5. Automatic recovery is selected only by the closed handler registry and only
   when the installed Foundation package has the exact SemVer and exact build
   identity recorded in the envelope. The Plan compiler identity must match the
   envelope identity. A newer, older, rebuilt-same-version, unknown-handler, or
   dependency-incompatible package preserves the evidence and blocks mutation.
   Recovery never loads consumer code.
6. Compatibility is deliberately bidirectional and fail-closed:
   - packages that predate envelope v3 treat its regular-file slot as unknown
     evidence, preserve it, and block mutation;
   - packages that implement envelope v3 recognize envelope v2 and journal v1
     only as manual-recovery evidence;
   - neither direction migrates, rewrites, deletes, or downgrades a journal.
7. Publication is create-no-replace. Before linking, Foundation durably records
   PREPARED, creates and durably identifies the exact Plan-derived temporary,
   then durably records PUBLISHING. It rechecks Plan authority, ancestry,
   destination absence, temporary identity, bytes, and mode immediately before
   publication. After linking it captures and verifies the destination's
   non-zero identity, bytes, mode, and same-file relationship, durably syncs the
   parent, removes only the identity-matched temporary, and durably records
   PUBLISHED before final receipt and identity-fenced journal removal.
8. Crash and race handling reports only proven outcomes:
   - PREPARED with no published destination may restart preparation after exact
     Plan reproduction;
   - PUBLISHING may resume only with the exact non-zero bound temporary,
     destination still absent, exact authority, and exact package identity;
   - a present destination in PUBLISHING, a missing or replaced temporary, or
     any ambiguous observation is manual-recovery-only;
   - PUBLISHED may finalize only when the exact destination bytes and its
     physical identity equal `publicationIdentity`;
   - a same-byte destination with a different identity is never adopted or
     deleted and requires manual recovery.
9. Cancellation is truthful. It may return `cancelled` only when Foundation has
   proved that no destination was published and has durably removed every
   identity-owned temporary and transaction record. Once publication has
   occurred or may have occurred, cancellation is masked: Foundation completes
   a provable commit or preserves all evidence for recovery. It never reports
   cancellation while leaving an active transaction or possible output behind.
10. Support for recognizing envelope v2 and journal v1 remains mandatory until
    all of these conditions are proven: organization inventory reports zero
    persisted instances across every admitted repository; every supported
    writer capable of producing them is retired; supported package policy no
    longer admits such a writer; a full support window has elapsed after that
    retirement; and a new accepted ADR names the removal release and its audit
    evidence. Time alone, npm age, or the release of v3 is insufficient.
11. Envelope v3 recovery support follows the exact-version policy for as long as
    any admitted repository can contain an active v3 transaction. Removal of a
    handler requires zero-instance inventory, retirement of all producing
    writers, expiry of the declared support window, recovery-fixture evidence,
    and a new accepted ADR. The exact recorded registry artifact remains the
    recovery authority throughout that window.

## Consequences

- Document Intent, Plan, and Receipt stay at v1; only the persisted transaction
  boundary advances because deployed evidence makes coexistence real.
- Publication identity closes the same-byte inode-replacement ambiguity without
  pretending a portable Plan can carry a durable inode promise.
- Old and new packages safely block one another at the transaction slot instead
  of guessing compatibility.
- Some interrupted transactions require manual resolution. This is intentional:
  unavailable physical identity and ambiguous publication are not recoverable
  authority.
- Organization inventory and package-retirement evidence become release inputs,
  not informal cleanup assumptions.

## Rejected alternatives

- Correct envelope v2 or journal v1 in place.
- Interpret a v2 PUBLISHED destination's matching bytes as publication ownership.
- Add publication identity as an optional journal v1 field.
- Automatically migrate a nonterminal journal before recovery.
- Allow a compatible range of Foundation versions to recover persisted work.
- Treat a zero physical identity as sufficient because the path and digest match.
- Abort after the publication boundary by deleting the destination.

The executable contract is documented in the
[Document authoring protocol](../architecture/document-authoring-protocol.md),
and the failure boundary is documented in the
[cooperative writer threat model](../security/document-authoring-threat-model.md).
