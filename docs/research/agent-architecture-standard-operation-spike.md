# Agent Architecture Standard D5 operation spike

Status: Complete; overlay-first selected

Date: 2026-08-26

Related documents:

- [Product decisions](agent-architecture-standard-product-decisions.md)
- [Implementation plan](agent-architecture-standard-implementation-plan.md)
- [Incubation ADR](../decisions/0036-incubate-agent-architecture-standard.md)

## Decision

The first public operation surface contains `validate-overlay@1` only.
`classify-subjects@1` and `evaluate-relations@1` remain internal or experimental
until a separate admission packet proves that each contract is narrow,
non-overlapping, deterministic, and independently useful.

The spike prototype is disposable evidence. It is not the reference
implementation, is not conformant production code, and must not be copied into
the public provider without closing the defects recorded below.

## Method

The hosted spike used a preregistered acceptance packet, a separately recorded
implementation/evidence sequence, and two independent adversarial reviews. No
consumer repository or real agent runtime was used.

Evidence chronology:

| Artifact | Identity |
| --- | --- |
| Original research snapshot | `afe5a001` |
| Revised preregistration | `ede18414ffe6eb98aebf08e08bb1f4fd8d76efd4` |
| Remediated implementation | `01d724e` |
| Evidence appendix | `8edffd5` |
| Revised preregistration blob | `45dc3dc4963aab9bcc7c0a184aa75c0994e5b8ae` |
| Revised preregistration SHA-256 | `d1a6db2...a19f92b` |

Hosted jobs:

- `aasv0-operations-spike-20260826-r3`
- `aasv0-operations-spike-review-20260826-r1`
- `aasv0-operations-spike-remediate-20260826-r1`
- `aasv0-operations-spike-review2-20260826-r1`

The first review rejected the original evidence because the caller could
contaminate overlay assertions, behavioral non-overlap was self-asserted, case
collisions could false-pass, and chronology was not independently verifiable.
The remediation preserved the preregistration and added focused tests and an
independent probe. The second review then tested outside those fixtures instead
of trusting their passing result.

## Evidence that passed

- Four scenarios produced genuinely useful actions before an overlay existed.
- Content substitution changed overlay, plan, and prospective identities.
- Missing relation assertions resolved to `needs-input` rather than pass.
- Caller-supplied planned subjects or relations did not change the overlay
  verdict, reason, plan identity, or prospective identity.
- Two newly tested case variants failed with `case-collision`.
- Resolution algebra and plan/state probes passed.
- One hundred serial and one hundred parallel identical requests were byte
  stable.
- The focused suite passed 13/13 tests and the independent probe passed 4/4.

The measured prototype processed 7,000 scenarios in 1,438.639 ms on Node
24.16.0, approximately 205.520 microseconds per scenario. This is feasibility
evidence only, not a performance budget.

## Admission failures

The final independent review found four P1 classes:

1. Exact replacement could overwrite an existing destination and still return
   pass. An add operation also accepted an ignored `newPath` field.
2. Equivalent permutations changed prospective identity when relations were
   present because the order-sensitive plan identity leaked into prospective
   state.
3. Classification and relation evaluation identities were coupled to the full
   combined policy even when the operation-specific assertions were unchanged.
4. The composed workflow emitted duplicate repair actions for the same unknown
   subject once an overlay was present.

The review also found that the focused tests compared selected assertions rather
than complete envelopes and omitted the exact relation-permutation and
overlay-deduplication cases that exposed these failures.

## Consequences

- Phase 4 implements one public overlay operation and keeps analyzers behind
  internal ports.
- The normative overlay vectors must include existing-destination replacement,
  forbidden operation fields, relation permutations, policy-slice isolation,
  and semantic repair deduplication.
- A future proposal for public classification or relation evaluation needs a
  new preregistration, independent fixtures, complete-envelope comparison, and
  an adversarial reviewer that did not author the implementation.
- Passing project-owned tests is insufficient evidence for public contract
  admission when an independent probe can still produce a false pass.

This resolves D5 without blocking the useful overlay-first vertical slice.
