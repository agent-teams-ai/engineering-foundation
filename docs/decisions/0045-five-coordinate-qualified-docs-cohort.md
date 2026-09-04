---
id: ADR-0045
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0045: Five-Coordinate Qualified Docs Cohort

Status: Accepted contract; implementation qualification pending

Date: 2026-09-04

Decision owner: Product owner

## Context

ADR-0043 split portable documentation behavior, managed Agent Teams policy, and
the reusable mutation and authoring mechanisms into independent packages. The
historical Cohort v1 wire model predates that split and binds only Docs Protocol
and Engineering Foundation. Inferring the missing packages from an installed
tree would make the same Cohort identifier resolve to different bytes.

The Cohort must close exact release identity without making every coordinate a
consumer manifest root or adding a compatibility layer for the old topology.

## Decision

1. Qualified Cohort v2 contains exactly five coordinates: Repository Mutation,
   Document Authoring, Docs Protocol, Docs Protocol Agent Teams, and Engineering
   Foundation. Every coordinate binds one exact semantic version and SHA-512
   registry integrity.
2. Only Docs Protocol, Docs Protocol Agent Teams, and Engineering Foundation are
   managed root development dependencies in a consumer manifest. Repository
   Mutation and Document Authoring are exact transitive coordinates. Managed
   qualification proves their lockfile resolution and permitted internal edges.
3. Consumer integration profile v3 is the only profile that selects Cohort v2.
   Its generated state uses managed-state schema v2, and its closed evidence
   uses qualification receipt v3. Unknown, missing, extra, or mixed generations
   fail closed.
4. A v2 Cohort declares explicit `upgrade_from` and `rollback_to` identifiers.
   Self-edges, duplicates, an unqualified target, or a rollback target outside
   the admitted upgrade origins fail closed.
5. Schema selection is explicit. Package count, installed modules, dependency
   shape, optional imports, and runtime discovery cannot select or translate a
   Cohort generation.
6. Cohort v1 and its profile, state, and evidence are immutable historical
   records. They may be inputs to explicit migration and rollback proof, but no
   compatibility command, bridge release, dual writer, or dynamic adapter path
   is created.
7. This record changes the Cohort and consumer-projection contracts only. The
   source dependency DAG remains solely owned by ADR-0043; qualification and
   rollout evidence do not create package import edges.

## Consequences

- One Cohort identity closes every independently published package required by
  managed documentation integration.
- Consumer manifests remain small while exact transitive mechanisms stay
  observable and qualified.
- V1-to-v2 migration is deliberate and reversible from recorded evidence, not
  an indefinitely supported legacy runtime.
- Adding or removing a coordinate requires a new versioned Cohort contract.

## Rejected alternatives

- Pin all five packages as consumer roots.
- Bind only direct roots and trust arbitrary transitive resolution.
- Infer a generation or adapter from installed packages or lockfile contents.
- Add a compatibility bridge, optional adapter import, or V1 dual writer.
