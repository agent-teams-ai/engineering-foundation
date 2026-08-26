# D5 operations spike preregistration

This disposable, non-conformant prototype compares two product surfaces against
the same fixtures:

- **A — overlay-first:** public `validate-overlay@1` only.
- **B — three operations:** public `classify-subjects@1`,
  `evaluate-relations@1`, and `validate-overlay@1`, plus a composed, read-only
  workflow.

The primary measure is the number of representative scenarios in which B emits
machine-actionable evidence before an overlay exists that A cannot emit without
inventing an overlay. A result is actionable only when it identifies a concrete
missing input or repair action tied to classification or relation evidence;
`provide-overlay` and successful confirmations do not count.

Retain all three public operations only if:

1. at least two representative scenarios gain such actionable pre-change
   evidence; and
2. each operation retains a narrow, non-overlapping contract: classification
   assigns vocabulary assertions, relation evaluation judges explicit relation
   candidates, and overlay validation alone checks exact mutation, freshness,
   atomicity, and prospective state.

Otherwise recommend overlay-first. Runtime and LOC are descriptive secondary
measures, not pass/fail gates. Expected scenario outcomes are declared in the
fixture before measurement and asserted by tests.
