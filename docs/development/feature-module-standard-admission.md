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
  codes, plus the example tree as real source files.
- Tests: the kernel runs every fixture, checks that every diagnostic code is
  exercised, that the report does not depend on input order, that the
  materialized example reads back to the same edges and the same report, and that
  no other package depends on this one.

## Validation in this delivery

| Evidence | State |
| --- | --- |
| Shared fixtures run by the kernel | done |
| Disposable project: the example tree, as a module and as source files | done |
| Real consumer: Engineering Foundation's checker uses the kernel for path containment, ownership-root overlap, v1 layer direction and cycle search, and the replaced code is deleted | done |
| Real consumer: feature-to-feature deep imports, layer direction and cycles through `checkFeatureModule` per module, built from the profile and the observed source graph | done |
| Real consumer: shared flat fixtures run against the repository checker | done (`tests/feature-module-kernel-adapter.test.mjs`) |
| Old and new checker compared on the real graph and on synthetic edges | see the pull request |
| `./node` runner on the public source graph | pending the source graph delivery |
| First npm publication and bootstrap approval | owner step |

The first publication waits for the pending rows.
