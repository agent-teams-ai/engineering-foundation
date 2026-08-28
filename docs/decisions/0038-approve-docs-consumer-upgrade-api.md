---
id: ADR-0038
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0038: Approve Docs Consumer Upgrade API

Status: Accepted

Date: 2026-08-28

Decision owner: Product owner

## Context

ADR-0037 requires one public consumer-upgrade command and a versioned machine
envelope. Docs Protocol is pre-1.0, and its released API baseline requires an
explicit decision-bound fingerprint before a changed declaration surface can
be promoted.

## Decision

Approve Docs Protocol public API fingerprint
`sha256:181c6e224092cae9505f524005b4f6595700bb518f07cb3e5a2dcd3a68266f70`
for the next minor release. The approved surface adds the upgrade function,
authority model, and execution envelope required by ADR-0037.

## Consequences

- The release baseline can include the one-command Cohort upgrade API.
- Later incompatible API changes require a new fingerprint and decision.

## Rejected alternatives

- Keep the upgrade available only through an untyped CLI side channel.
- Reuse an unrelated historical breaking-change approval.
