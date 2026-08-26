# D5 operations spike remediation preregistration

Date: 2026-08-26
Status: fixed before remediation implementation; disposable research evidence

This preregistration preserves the original D5 decision gate and adds the
adversarial checks required after independent review. `PREREGISTRATION.md` and
the original evidence remain immutable historical inputs.

## Preserved decision gate

Compare the same two surfaces:

- **A — overlay-first:** public `validate-overlay@1` only.
- **B — three operations:** public `classify-subjects@1`,
  `evaluate-relations@1`, and `validate-overlay@1`, plus a composed, read-only
  workflow.

Retain all three public operations only if at least two representative
scenarios gain concrete, machine-actionable pre-change classification or
relation evidence which A cannot emit without inventing an overlay, and all
three operations remain behaviorally narrow and non-overlapping. A successful
confirmation and `provide-overlay` do not count. The expected fixture outcomes
must be declared before measurement. Runtime and LOC remain descriptive only.

Failure of any additional mandatory acceptance condition below fails the
remediated gate even if the numerical gain threshold passes.

## Mandatory adversarial acceptance

1. **Exact mutation binding.** Overlay validation derives the affected
   prospective subjects and relations from the required base snapshot and the
   exact add/replace/delete and relation mutations. Optional caller
   `plannedSubjects` or `plannedRelations` cannot supply, omit, or substitute
   what is validated. Changing any identity-bearing mutation field changes the
   plan/overlay/prospective identity and an unrelated-mutation substitution
   cannot reuse a passing result.
2. **Behavioral non-overlap.** Metamorphic tests, rather than declared concern
   strings, prove ownership. Holding shared inputs fixed, classification-profile
   changes may change only classification assertions; evaluator-profile or
   relation-candidate changes may change only relation verdicts; overlay
   freshness, mutation, and path-precondition changes may change only overlay
   validation. The composed workflow may propagate causal changes but must
   preserve the three operation identities and deduplicate the same causal
   repair action.
3. **Case-fold state updates.** Portable case-collision state is updated after
   every successful add, replace, and delete in operation order. Tests include
   two new paths differing only by case, delete/add case renames, and later
   operations observing earlier virtual mutations.
4. **Planned/observed identity.** Every classification and relation resolution,
   including `needs-input` and `indeterminate`, carries its planned/observed
   state. Planned resolutions bind the exact plan identity; observed
   resolutions bind no plan. Missing or mismatched plan identity changes the
   semantic resolution or verdict and is never merely echoed.
5. **Resolution algebra and diagnostics.** `decided` always has a `pass` or
   `fail` verdict. `needs-input`, `indeterminate`, and `stale` never masquerade
   as decided. A decisive failure remains a failure when another target is
   unknown, while unknown-only batches retain their epistemic state. Mixed
   independent causes are all diagnosed deterministically rather than hidden
   behind the first cause.
6. **Hostile and control vectors.** Tests cover invalid path and overlay input,
   unrelated mutation substitution, omitted assertions, duplicate semantic
   concerns/actions, mixed outcomes, incomplete observation, and a clean
   control. The same logical request is byte-stable under repeated and parallel
   execution and has defined order behavior under permitted input
   permutations.
7. **Narrow composition.** The composed workflow calls only the narrow public
   operations. Overlay validation uses private narrow profile helpers and does
   not call, return, or expose complete public classify/evaluate envelopes.

## Evidence and claim boundary

Focused tests and a separately invoked probe must exercise the adversarial
conditions. The remediation evidence records actual measured LOC and runtime,
the preregistration digest, implementation commit, commands, and outcomes. A
passing result supports only the bounded D5 product-surface recommendation; it
is not conformance, security, production readiness, public-ID acceptance, or a
real-consumer claim.
