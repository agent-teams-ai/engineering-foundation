# D5 operations spike evidence

Date: 2026-08-26
Status: disposable research evidence; not a product or conformance claim

## Question and decision rule

The spike compared (A) public `validate-overlay@1` only with (B) separate public
`classify-subjects@1`, `evaluate-relations@1`, and `validate-overlay@1` plus a
read-only composed workflow. The rule was fixed in `PREREGISTRATION.md`: retain
all three only if at least two representative scenarios gain concrete
pre-change evidence that A cannot express without inventing an overlay, and all
three contracts remain narrow and non-overlapping.

## Scenario matrix

Before an overlay exists, A can only request `provide-overlay`. Successful
confirmations do not count as actionable gains.

| Scenario | B before overlay | Distinct action | Exact-overlay check | Gain? |
| --- | --- | --- | --- | --- |
| Unknown subject | classification needs input | `map-subject` | fails prospective policy | yes |
| Planned vs observed relation | observed edge passes; planned reverse edge fails | `reverse-or-remove-relation` | fails prospective policy | yes |
| Mixed outcomes | per-target pass and needs-input resolutions survive | `map-subject`, `classify-relation-endpoints` | fails prospective policy | yes |
| Stale base | classification passes | none | `stale` before application | no |
| Delete/rename/case ambiguity | no pre-change claim | none | rejects `src/Foo.js` to `src/foo.js` ambiguity | no |
| Incomplete observation | negative relation query is indeterminate | `complete-relation-observation` | indeterminate, never pass | yes |
| Clean control | classifications and relation pass | none | exact overlay passes | no (expected) |

Result: **4 of 6 representative adversarial scenarios gained actionable
pre-change evidence**, exceeding the threshold of 2. The clean control did not
invent work or block the exact overlay.

## Contract, duplication, and coupling findings

- `classify-subjects@1` only maps explicit opaque subject references to a named
  vocabulary or requests a mapping. It does not judge relations or mutations.
- `evaluate-relations@1` only judges explicit role-named candidates and retains
  their `planned` or `observed` state. It consumes classification assertions but
  does not create an overlay or infer repository facts.
- `validate-overlay@1` alone owns base freshness, operation preconditions,
  portable-path ambiguity, atomic virtual application, prospective identity,
  and the rule that incomplete relevant observation cannot pass.
- The workflow is composition, not a fourth semantic operation. It preserves
  every per-target resolution and adds no hidden state.
- The prototype reuses the classify/evaluate functions during prospective
  overlay reevaluation, so policy logic is not duplicated. This creates a real
  dependency from overlay orchestration to their assertion/result shapes, but
  not overlapping public responsibility. Production boundaries should depend
  on small assertion/evaluation ports rather than nesting whole public result
  envelopes as this prototype does.
- Overlay-first would still need much of the classification and relation logic
  internally to reevaluate prospective state. Publishing the narrow operations
  therefore adds contract and fixture surface, but little algorithmic
  duplication, while exposing evidence four fixtures use before a patch exists.

## Size and runtime

The measured prototype contains 343 nonblank, non-comment JavaScript LOC across
implementation, measurement harness, and tests (283 physical implementation and
measurement lines plus 90 physical test lines; the nonblank count is the stable
comparison). Fixtures add 118 physical lines.

On the hosted Linux sandbox with Node v24.16.0, 1,000 iterations over all seven
scenarios (7,000 scenario runs) took **357.929 ms**, or **51.133 microseconds per
scenario**. Seven focused tests passed in **440.408 ms** total. These timings
show only that the surface comparison is cheap at fixture scale; they are not a
filesystem, analyzer, security, or production latency benchmark.

## Verdict

**Recommend retaining all three independently claimable operations plus one
non-normative composed workflow for the next experimental design step.** The
pre-registered rule passes (4 gains, threshold 2), and the prototype preserves
three narrow contracts. This settles only the bounded D5 product-surface spike;
it does not accept D5, publish operation IDs, or replace the owner/ADR decision.

## What must not enter production

- this prototype or its synthetic prefix policy as an implementation shortcut;
- `JSON.stringify` digests, locale case-folding, or the simplified path model;
- inferred trust, completeness, or security from caller-supplied fixture data;
- the nested result-envelope coupling used by overlay reevaluation;
- absent schema decoding, canonicalization, budgets, cancellation, provenance,
  extension, privacy, hostile-filesystem, and independent-conformance controls;
- any repository write, package activation, merge gate, public identifier, or
  consumer claim based on this spike;
- the microbenchmark as a forecast of real snapshot or analysis performance.

The production work, if approved separately, must be implemented from the
language-neutral contracts and adversarial conformance evidence described in
the research documents, not by promoting this sandbox code.

---

# D5 spike remediation result

Date: 2026-08-26
Status: bounded remediation evidence; original evidence above is unchanged

This section reports the result against `PREREGISTRATION-V2.md`, which was
committed as `ede1841` before implementation commit `01d724e`. The fixed V2
preregistration SHA-256 is
`d1a6db2d7eb7e79faae431d0407e3d1f87dcb0c0cdd6a392909523764a19f92b`.
The historical `PREREGISTRATION.md` prefix remains byte-identical to commit
`f925196`; this remediation section does not revise its original result.

## Remediation outcomes

| Independent-review concern | Evidence after remediation | Result |
| --- | --- | --- |
| Exact mutation/prospective binding | Plan identity derives only from base, exact file mutations, and exact relation mutations; content substitution changes both plan and prospective identities; optional `plannedSubjects`/`plannedRelations` do not affect the verdict or prospective identity | pass |
| Nested public-envelope coupling | Overlay validation uses private narrow path/relation profile helpers and exposes no classify/evaluate result envelopes; the composed workflow alone calls the three public operations | pass |
| Behavioral non-overlap | Metamorphic tests alter classification, relation evaluation, and overlay freshness independently and assert only the owned result dimension changes | pass |
| Causal action duplication | Composition keys repair actions by semantic cause; the mixed fixture emits one mapping action for the unknown endpoint even though classification and evaluation both encounter it | pass |
| Case-collision mutation state | Sequential virtual state is updated by add, replace/rename, and delete; vectors cover two new case variants, replace then path reuse, exact delete/restore, and ambiguous case rename | pass |
| Planned/observed identity | Every classification and relation resolution carries state and nullable plan identity; missing and mismatched planned identities change resolution/verdict | pass |
| Resolution algebra and mixed causes | Every `decided` result has `pass`/`fail`; incomplete-only evidence is indeterminate, while an independent syntactic failure remains decided/fail; all deterministic diagnostics survive mixed policy causes | pass |
| Invalid and adversarial inputs | Invalid overlay/path, unrelated substitution, omitted untrusted assertions, mixed outcomes, incomplete observation, and clean control are covered | pass |
| Determinism | Twenty repeated and twenty parallel executions are byte-identical; independent mutation permutations have order-sensitive plan identities but the same resulting prospective identity and verdict | pass |

The preserved numerical gate remains **4 representative actionable gains**, with
the same four gaining scenarios and threshold of 2. The clean control still
passes without invented work. The mandatory V2 adversarial conditions also
pass, so the bounded recommendation remains three independently claimable
operations plus one non-normative composed workflow.

## Commands and observed measurements

Run from `spike/` on the hosted Linux sandbox with Node v24.16.0:

- `node --test`: 13/13 tests passed in **204.016 ms**.
- `node probe/adversarial-probe.js`: 4/4 separately invoked adversarial probes
  passed.
- `node src/measure.js`: 1,000 iterations over seven scenarios (7,000 scenario
  runs) took **959.174 ms**, or **137.025 microseconds per scenario**.

The remediated JavaScript has **754 physical lines**: 493 implementation and
measurement lines, 220 focused-test lines, and 41 independent-probe lines. The
measurement harness counts **694 nonblank, non-comment JavaScript lines** across
those files. The JSON fixture is 120 physical lines. These are observed spike
measurements, not estimates or production forecasts.

## Claim boundary

This result remediates the identified P1 and relevant P2 defects in the
disposable D5 surface experiment. It supports only the original bounded
recommendation for the next experimental design step. It does not establish
conformance, security, production readiness, filesystem behavior, ecosystem
demand, public operation-ID acceptance, or evidence from a real consumer. The
original “What must not enter production” restrictions remain in force.
