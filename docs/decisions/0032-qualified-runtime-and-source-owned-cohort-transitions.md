---
id: ADR-0032
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0032: Qualified Runtime and Source-Owned Cohort Transitions

Status: Accepted

Date: 2026-08-17

Decision owner: Product owner

## Context

ADR-0030 and ADR-0031 established recoverable known-file transactions and the
Docs Protocol consumer-integration boundary. Qualification found two additional
facts that must be explicit without mutating those accepted decisions: direct
package pins do not bind the executable dependency graph, and central migration
authority cannot make an installed source package execute an unbundled target.

## Decision

1. Preimage evidence is copied independently from the live identity witness.
   Destination publication is no-replace, external hardlinks are rejected, and
   the journal binds deterministic retirement identities. Temp and retirement
   parent directories are durably synchronized before their identities become
   recovery authority.
2. Successful transaction completion re-verifies every final postimage after
   cleanup and before emitting the receipt. Recovery and cleanup are idempotent;
   an unverifiable or no-longer-bound artifact is preserved and reported.
3. The committed consumer projection carries only an immutable Cohort binding.
   Mutable lifecycle, canary admission, support, suspension, and fleet
   eligibility remain central governance state evaluated by the trusted gate.
4. Runtime identity binds the complete reachable pnpm v9 closure from the two
   exact package roots, including peer-qualified and optional dependency edges
   and each physical package SRI. Consumer planning recomputes the same digest
   from its committed lockfile before any managed publication.
5. Migration execution is source-owned. A package release carries a separate,
   content-addressed transition catalog identifying its exact source executors
   and bundling every directly reachable target Cohort's immutable binding and
   managed assets. A central `upgradeFrom` or `rollbackTo` edge is necessary but
   cannot grant an installed CLI an executor it does not bundle.
6. The first production Cohort has no fabricated rollback edge and is
   fix-forward only. A later source package may qualify rollback by bundling the
   prior Cohort while central governance still considers that target eligible.
7. The integration profile, exact installed source executor, dependency pair,
   and lockfile closure are read-only transaction guards. The package manager
   remains the sole lockfile writer.

## Consequences

- Transitive dependency drift fails before package execution in the trusted
  gate and before consumer mutation locally.
- Emergency central suspension can stop new selection without rewriting
  committed consumer bytes.
- Historical rollback is reproducible only when both governance authority and
  package-owned executable evidence exist.
- The larger serialized CAS functions require temporary, exact, accountable
  lint waivers while their next structural extraction is designed and reviewed.

## Rejected alternatives

- Treat only the direct package versions and SRIs as executable identity.
- Let mutable central governance inject historical assets or executable hooks.
- Declare a rollback edge for the first Cohort without a real source executor.
- Rewrite ADR-0030 or ADR-0031 after acceptance.
