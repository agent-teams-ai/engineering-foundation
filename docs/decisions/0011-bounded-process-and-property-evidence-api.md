---
id: ADR-0011
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0011: Bounded Process and Property Evidence API

Status: Accepted

Date: 2026-08-03

Decision owner: Product owner

## Context

The deterministic tooling foundation needs public process deadline and
cancellation controls, plus portable property-test replay evidence. The package
already released `ProcessRequest`, so even optional members are conservatively
classified as breaking by ADR-0004.

The observed change is additive only: no released item is removed or changed.
It adds optional `timeoutMs` and `signal` members to `ProcessRequest` and adds
new property-testing evidence types and helpers.

## Decision

Approve public API fingerprint
`sha256:32e703cac807a3a87a50b922ac8cdcfd5d8c9b5153d12f2fc9c69e28e02807dc`
for the next minor release before `1.0.0`.

The process controls remain optional so existing callers retain their previous
behavior. Deadline and cancellation share the bounded process runner instead of
creating capability-specific process implementations. Property replay evidence
uses versioned, validated records and deterministic normalization.

This approval is exact. It does not authorize a changed or removed public item,
an additional member, or a different fingerprint.

## Consequences

Consumers can apply one cancellation and deadline model across local tooling,
including Windows descendant containment. Property failures can be reproduced
from portable seed, path, run-count, and counterexample evidence. Any further
change requires normal compatibility evidence and, when classified breaking,
a separate accepted decision.
