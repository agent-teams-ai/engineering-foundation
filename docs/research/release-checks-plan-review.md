# Release candidate checks plan review

Status: review program started on 2026-10-20. Implementation has not started.

The owner requested three sequential improvement rounds followed by three
independent critical-review rounds before implementation. This record concerns
the [current delivery plan](../development/release-checks-delivery-plan.md).
Earlier research and its eight critics are inputs, not substitutes for these
six requested rounds or final implementation review.

## Read-only preflight

Current Foundation source is `bbaf422dae36f0aa3ed9234a197aef076c64c63e`;
Get Modular is `ddf1e0b0053f546f12ca70190b237b4f7e78d09d`; node-or-bun is
`3e6a1c44195680761787e4377fc560dd0f22e223`.

Three independent technical preflights established the following:

- **Contract and reuse:** existing manifest equality is transferable; exact
  frozen-plan/candidate consistency is a new common guarantee. Whole-tree
  observation, content restrictions and binding must remain in the contract.
- **Foundation admission:** the independent pure leaf fits existing admission;
  every current catalog/ownership/typecheck/coverage projection must include it.
  The frozen historical eight-package migration packet remains unchanged. Public
  admission intentionally blocks ordinary publication until existing bootstrap.
- **Consumer integration:** a neutral independent leaf is not a Foundation
  dependency for node-or-bun. Its published root metadata needs a truthful patch.
  Get Modular still needs the narrow retained-input successor even when its
  pending real Resources patch is released, because four packages retain bytes.

These were source reads, not executed engine, CI, registry or E2E evidence.

## Requested review sequence

| Round | Scope | Reviewed plan identity | Outcome and disposition |
| --- | --- | --- | --- |
| I1 | Contract, Clean Architecture and semantic reuse | `80fcc900f0f0844aac1ee07647515556828a00e3` | CHANGE; I1-01 through I1-03 addressed in draft 2 |
| I2 | Admission, sequencing and operational recovery | Pending | Pending |
| I3 | Minimal consumer integration and acceptance scope | Pending | Pending |
| C1 | Independent correctness and counterexamples | Pending | Pending |
| C2 | Independent operational/consumer criticism | Pending | Pending |
| C3 | Independent final scope and consistency review | Pending | Pending |

Each round reads the actual revised plan, reports concrete findings and their
required disposition, and finishes before the next round begins. Record the
reviewed content digest and subsequent change, including a supported no-change
verdict. No fabricated reviewer receipt or unobserved execution is evidence.

## I1 — contract and semantic reuse

Reviewed plan SHA-256:
`bcaf77d0d8d7c06800eef5b11078e2927bd2d386ad6f544b840e51fccf06c1ed`.
Independent role: contract and architecture reviewer. Verdict: CHANGE.

| Finding | Disposition in draft 2 |
| --- | --- |
| I1-01: donor equality also protects native API pre-mutation and later PR attestation; the outer generation call alone is insufficient | Named every affected production seam, preserved checks before baseline mutation and on actual PR head/base, prohibited synthetic expected facts and duplicate equality, retained per-seam negatives |
| I1-02: equal supplied digests or twice-read historical source do not bind actual execution; a second collector risks divergent plan authority | Bound actual root/Git/processed commit/CLI/config and their re-observation; admitted the action's legitimate branch reset; reused the existing official-plan collector and added actual execution-drift negatives |
| I1-03: complete plan records and actual version-edit set differ for v3 none/private/ignored records | Preserved complete records and explicit absence, compared only required edits, made consumption expectation explicit and added a mixed unchanged/real-release fixture |

No new package, CLI, facade, DI layer, generic inventory utility or rewrite API
was required. Implementation remains pending I2-I3 and C1-C3.
