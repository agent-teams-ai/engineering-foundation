---
id: ADR-0034
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0034: Fix-Forward Stable Cohort Admission

Status: Accepted

Date: 2026-08-23

Decision owner: Product owner

## Context

ADR-0032 requires source-owned transition executors and forbids fabricated
rollback edges. Qualification of the first stable Docs Protocol release found
that the current V1 target-first lifecycle cannot honestly bind a rollback
executor to the same not-yet-published package SRI: the transition catalog is
part of the tarball whose SRI it would need to declare.

The first stable package can still safely adopt the qualified RC3 fleet by
bundling RC3 as a direct immutable target. Central governance must distinguish
that proven upgrade from an unproven rollback instead of blocking the upgrade or
advertising symmetry that the executable evidence does not provide.

## Decision

1. A successor Cohort requires at least one explicit `upgrade_from` origin but
   may declare an empty `rollback_to` list. An empty list is an explicit
   fix-forward policy, not missing evidence.
2. The published transition catalog must bundle every declared upgrade origin's
   immutable Cohort projection and content-addressed managed assets. Central
   qualification verifies those bytes against the authoritative registry.
3. A digest-valid catalog that omits or misbinds an upgrade origin is not
   deployable and cannot become Qualified, Canary, or Recommended.
4. The first stable Cohort upgrades from the current RC3 Cohort and declares no
   rollback target. Incidents after adoption use suspension and a reviewed
   fix-forward package.
5. A future rollback edge requires a separate lifecycle ADR and executable
   package evidence that bind source package, source lock, target package, and
   target lock without self-reference.
6. Governance and package catalogs must never manufacture a rollback edge to
   make a transition appear symmetric.

## Consequences

- Current RC3 consumers can move to stable through a package-owned, verified
  transition instead of a manual rewrite.
- Stable adoption remains fail-closed: the central controller rejects an
  unreachable or byte-mismatched origin even when the catalog digest matches.
- V1 stable incidents use bounded suspension and fix-forward recovery until a
  real rollback lifecycle is designed and qualified.
- Transition direction is explicit and may be asymmetric.

## Rejected alternatives

- Embed the package's future SRI in its own tarball.
- Treat a catalog digest alone as proof that every governed edge is executable.
- Publish a nominal rollback edge whose executor cannot pass target-first lock
  guards.
- Block stable adoption until a hypothetical V2 rollback lifecycle exists.
