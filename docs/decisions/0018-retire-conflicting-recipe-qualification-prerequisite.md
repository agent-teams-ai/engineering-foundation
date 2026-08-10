---
id: ADR-0018
status: accepted
supersedes:
  - ADR-0013
superseded_by: []
---

# ADR-0018: Retire the Conflicting Recipe Qualification Prerequisite

Status: Accepted

Date: 2026-08-08

Decision owner: Product owner

## Context

ADR-0017 replaced the timing requirement for a second real consumer, but
ADR-0013 remained accepted and repeated the old prerequisite in decision item
9. The accepted decision graph therefore exposed two contradictory
qualification rules even though the current product decision was explicit.

ADR-0013 is immutable historical evidence. Its lifecycle must be corrected by
a successor rather than by editing its accepted content.

## Decision

1. Supersede ADR-0013 so its second-consumer prerequisite is no longer an
   active architecture rule.
2. ADR-0017 is the authority for staged Recipe qualification and remains
   unchanged.
3. The source-bound authority, read-set, recovery, and fail-closed decisions
   introduced by ADR-0013 remain required. Their canonical current statement is
   the scaffolding compiler protocol and the implementation they govern.
4. This decision changes no Plan, Receipt, journal, verifier, or public API
   contract. It corrects only the decision lifecycle graph.

## Consequences

- The accepted ADR graph has one active Recipe qualification rule.
- ADR-0013 remains available as historical evidence without retaining an
  active contradictory prerequisite.
- Source-bound authority and recovery semantics remain mandatory.

## Rejected alternatives

- Edit accepted ADR-0013 item 9 in place.
- Leave contradictory accepted decisions and explain precedence only in prose.
- Change ADR-0017 after its immutable baseline was promoted.
