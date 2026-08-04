---
id: ADR-0012
status: accepted
supersedes:
  - ADR-0010
superseded_by: []
---

# ADR-0012: Single Source Dependency Schema

Status: Accepted

Date: 2026-08-05

Decision owner: Product owner

## Context

The source-dependency capability briefly exposed two configuration schemas while
the repository was still establishing its first consumer contract. No consuming
repository enabled the second schema on its main branch. Carrying both schemas
would preserve migration machinery before there is a deployed migration need
and make the initial contract harder to understand.

The safety behavior introduced with the normalized observed graph is still
required. Explicit boundary entrypoints, ambiguous classification rejection,
cross-boundary import fencing, and runtime and type-only cycle detection cannot
be weakened as part of simplifying the schema identity.

## Decision

`architecture.source-dependencies` exposes one configuration schema,
`schemaVersion: 1`. It requires every boundary to declare `entrypoints`, including
an explicit empty list when a boundary has no inbound local-import surface.

The capability accepts no legacy schema alias. Configuration values other than
`1` fail closed. All observed-graph safety checks apply unconditionally under the
single schema.

Exact package pins keep the correction explicit. A repository using the
short-lived package `0.6.0` source-dependency configuration must change only its
schema version from `2` to `1`; its declared entrypoints and architecture policy
remain unchanged.

## Consequences

Consumers see one initial schema and one behavior path. The implementation no
longer contains compatibility branches that could accidentally weaken cycle,
classification, or entrypoint enforcement.

Published historical package artifacts and ADR-0010 remain immutable evidence.
A future incompatible configuration change still requires a new schema version
and a proven consumer migration need.
