# Exact historical Markdown artifact policy

## Scope and decision

The owner requested completion of ReviewRouter native reference adoption.
Design review accepted an additive Foundation-owned policy on 2026-11-27;
implementation and qualification are separate. The inspected Foundation base is
`7438b7ee4429dc7798cf2b18c81e6bc7788f0f5b` (package 4.0.3).

ReviewRouter #1002 retains complete `docs`, `ai-docs` and `architecture` roots.
Its frozen independent-review artifact contains 21 historical absolute
references. Its raw SHA-256 remains
`7abaefccd0fa7771c6594824df794415801771f68f14bf0521d2d2461b360528`;
neither the artifact nor its provenance/consumer gates belongs to this upstream
change.

The [v2 contract](../reference/documentation-local-references.md) adds exact path,
raw digest and occurrence declarations. It preserves all ordinary validation,
retains historical findings as explicit information and rejects changed bytes,
stale records and undeclared occurrences. Existing v1 schema bytes, released API
baselines, parser semantics and root scope stay intact.

## Alternatives and estimate

Only two alternatives satisfy the assigned boundaries without a waiver or
excluded root. The ordinal scores express design judgment, not measured
reliability. Estimates assume existing prerequisites and focused review.

| Option | Production/integration LOC | Tests/fixtures LOC | Engineer-days | Fitness / reliability / complexity |
| --- | --- | --- | --- | --- |
| Selected: hash the lossless observed source in a private Foundation crypto adapter | 300–500 | 400–700 | 1.5–3.5 | 9 / 9 / 3 |
| Add a raw digest to the public Document Authoring observation model, then use the same v2 policy | 380–620 | 500–850 | 2–4 | 8 / 9 / 5 |

Both are strict about the same observed artifact. The second adds a public API
and another package/release without strengthening this reader's byte contract.
The selected option depends on fatal UTF-8 decoding and preservation of the
original source. Independent inspection confirmed both; BOM, CRLF, non-ASCII
and invalid-UTF-8 regressions qualify that assumption.

LOC estimates exclude prose, generated topology/artifact metadata and release
automation. Confidence is moderate until the complete candidate is qualified.
A generic historical-artifact framework, a findings baseline and a local
filtering wrapper are outside this scope.

## Review and qualification boundaries

Independent design review accepted the narrow policy and required all-or-nothing
artifact admission, non-vacuous declarations, source/case/symlink failures,
unchanged v1 loader shape and schema-first validation, actual requested schema
identity in reports, and real CLI historical-information and mixed-error cases.
The shared reporting default treats any diagnostic as a violation; only this
capability explicitly passes an empty result or its own admitted historical
information diagnostics.

The focused strict TypeScript and runtime cases cover those boundaries. Complete
test inventories, native CI, package membership and the normal minor Foundation
release with its exact FMS development-dependency republish remain required.
No unchanged released schema/API baseline is rewritten. Publication and
ReviewRouter's exact package pin, full-root native check and rejecting
immutable-evidence tests remain separate downstream steps.

This record describes the accepted design and intended checks. It does not
claim a passing test, package publication or consumer adoption.
