# Feature Module Standard package admission

Source admission of `@agent-teams/feature-module-standard`, an opt-in package for
development and CI. The decision is
[ADR-0062](../decisions/0062-feature-module-standard-package-admission.md) under
[ADR-0061](../decisions/0061-library-first-foundation-boundary-evolution.md).
This note records what the source checkpoint contains and what is still pending.

## Contents

- `.`: a pure kernel. Input is declared facts, output is diagnostics with stable
  codes and per-feature metrics. It reads no files, runs no parser, has no
  dependencies and widens no repository policy. It implements Feature Module
  Standard v1.1 and exports the identity and digest of that exact text.
- `./fixtures`: the informative examples of v1.1, the cycle cases, the
  composition-contract cases and the republication cases as data with expected
  codes, plus the example tree as source texts.
- Tests: the kernel runs every fixture, checks that every diagnostic code is
  exercised, that the report does not depend on input order, that the
  materialized example reads back to the same edges and the same report, and that
  no other package depends on this one.

## Validation in this delivery

| Evidence | State |
| --- | --- |
| Shared fixtures run by the kernel | done |
| Disposable project: the example tree, as a module and as source texts | done |
| Real consumer: Engineering Foundation's checker uses the kernel for path containment, ownership-root overlap, v1 layer direction and cycle search, and the replaced code is deleted | done |
| Real consumer: feature-to-feature deep imports, layer direction and cycles through `checkFeatureModule` per module, built from the profile and the observed source graph, failing closed on an untranslated kernel error | done |
| Real consumer: the shared fixtures that a flat profile can express run through the repository checker's kernel adapter | done (`tests/feature-module-kernel-adapter.test.mjs`) |
| Old and new checker compared on the real graph and on synthetic edges | done, see below |
| Packed archive imported by name (`.`, `./fixtures` and `./node`) in a disposable consumer | covered by the runner package qualification |
| `./node` runner on the public source graph | implemented; materialized examples, module composition and runtime/type-only republication regressions run in `tests/features/feature-module-standard/node-runner.test.mts` |
| Engineering Foundation 1.8.0 Version PR (#392) | held until the runner merges, so that 1.8.0 and the first release of this package ship together |
| Bootstrap approval and bootstrap publication of the npm name | completed for the deprecated `0.0.0` artifact; retained catalog approval and published evidence remain historical, separate from the supported release |

The first supported publication waits for the normal release gates; the deprecated
bootstrap artifact is not a consumer adoption candidate.

## Comparison of the old and the new checker

The checker of base `5a4efcf75` was compared with the checker of `3f8713e2d` (this branch after merging `main`) on
the same observed source graph and the same surfaces. On the real graph both
report 0 problems. An independent rerun on the same repository state, with 300
random feature-to-feature edges and 60 batches of 25 edges, agrees on rejection
or acceptance in all 360 trials, and the deep-import and layer-direction
findings match everywhere. In 10 trials, all in `docs-protocol`, the two
checkers list different cycle paths of the same strongly connected component.

Cycles are compared by the strongly connected components they lie in and by the
pass or fail of each case. The old checker searched one graph of all modules, so
it could list more elementary cycles of the same component than the per-module
kernel; the listed cycle paths differ, the rejection does not.

The comparison found and fixed three kernel differences on the way: a deep
import also reports the direction rule, a deep import counts as an edge of the
cycle graph, and the local contracts strengthening applies only where the kernel
allows the edge. The comparison scripts are not retained.

## Release impact

The namespace bootstrap completed on 2026-10-17. The catalog preserves its exact
reviewed archive integrity and package tree as historical evidence. The normal
release still verifies that published baseline; adding the runner does not
authorize a second bootstrap or change those immutable artifact identities.
