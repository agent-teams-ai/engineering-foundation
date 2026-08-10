---
id: ADR-0017
status: accepted
supersedes:
  - ADR-0006
superseded_by: []
---

# ADR-0017: Staged Scaffolding Recipe Qualification

Status: Accepted

Date: 2026-08-08

Decision owner: Product owner

## Context

ADR-0006 established the closed deterministic scaffolding protocol and required
a real donor plus a second consumer before a reusable product Recipe could be
qualified. ADR-0013 repeated that timing requirement while introducing
source-bound authority. The protocol and authority mechanism are now proven
independently. The Orchestrator has one real package generator and one completed
package whose evolution demonstrates the distinction between a generated
technical envelope and consumer-owned feature implementation.

Waiting for Agent Runtime or Platform production packages would couple the first
technical Recipe to unrelated product schedules. Treating synthetic fixtures as
another real consumer would hide that coupling instead of removing it.

## Decision

1. Retain every closed compiler, ownership, protocol, and extension decision in
   ADR-0006. This ADR replaces only its qualification sequence and the second
   consumer timing statement in ADR-0013 item 9. All ADR-0013 authority and
   recovery decisions remain unchanged.
2. One real donor is sufficient to implement and release a narrowly named
   technical Recipe after exact donor-byte parity, source-bound authority,
   recovery, packaged-use, and consumer conformance are proven.
3. `local-host-control` is the first and only required real donor for the generic
   Node TypeScript library-boundary Recipe.
4. Foundation fixtures vary opaque roles, path depths, package names, owner IDs,
   parameter rejection, and failure modes. They prove generic mechanics but are
   not represented as independent product consumers.
5. Qualification is staged and explicit:
   - `IMPLEMENTED` means Foundation code and its conformance evidence exist;
   - `ORCHESTRATOR_QUALIFIED` means the donor bytes, recovery semantics, and
     Orchestrator post-Apply gates pass in the consumer repository;
   - cross-project evidence is added only when another real consumer exists.
6. A Foundation Receipt proves only the reviewed package-envelope bytes. The
   consumer must add its accepted feature and any root project reference in the
   same change before claiming a valid product package.
7. The first Recipe creates libraries only. It does not create applications,
   DDD layers, feature slices, Nx projects, dependencies, or root configuration.
8. A later Agent Runtime or Platform qualification must use the same released
   Recipe contract. It may add evidence but cannot retroactively change existing
   output bytes or consumer authority semantics under contract version 1.

## Consequences

- Orchestrator can remove duplicated generator mechanics without waiting for AR
  or Platform implementation.
- The first Recipe is qualified only for its narrow library-boundary semantics;
  broader cross-project confidence remains intentionally unclaimed.
- A second real consumer can expose a missing generic variation. Such a change
  requires a new Recipe contract version or a separately proven definition, not
  a silent reinterpretation of version 1.
- The rest of ADR-0006 remains the design basis and is restated by the current
  scaffolding protocol document.

## Rejected alternatives

- Block the first Recipe until AR or Platform begins production coding.
- Call synthetic fixtures a second real consumer.
- Copy Orchestrator roles or package identities into Foundation.
- Generalize the first Recipe to applications, DDD, frontend, or Rust before a
  real donor proves those contracts.

The canonical current design is the
[Scaffolding compiler protocol](../architecture/scaffolding-compiler-protocol.md).
