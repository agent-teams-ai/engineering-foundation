# Maintainability Budget Evaluation

Status: Accepted and implemented in Foundation; consumer adoption remains opt-in.

Date: 2026-08-02

## Confirmed facts

The published Oxlint `base.json`, `node.json`, and `type-aware.json` presets do
not enable file-length, function-length, complexity, nesting, or parameter-count
rules. The active quality-gate documentation therefore must not be interpreted
as enforcing those budgets.

Oxlint provides independent rules for
[`max-lines`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-lines),
[`max-lines-per-function`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-lines-per-function),
[`complexity`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/complexity),
[`max-depth`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-depth), and
[`max-params`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-params).
File length alone is not a reliable architecture boundary, so one rule cannot
stand in for the other signals.

A dry run against `packages/engineering-foundation/src` with Oxlint defaults
reported eight files above 300 lines and 29 functions above 50 lines. A second
dry run with the proposed production profile below reported 13 diagnostics
across six files. The largest case is `local-mode/service.ts`: 771 physical
lines and 731 lines after blank and comment lines are excluded.

## Accepted profile

The implementation is an explicitly extended maintainability
preset, not an addition to `base.json` or `node.json`. Installing or upgrading
Foundation must not silently activate a new maintainability policy in a
consumer.

Production source profile:

| Signal | Budget |
| --- | ---: |
| File lines, excluding blank and comment lines | 500 |
| Function lines, excluding blank and comment lines | 150 |
| Cyclomatic complexity | 20 |
| Block nesting depth | 4 |
| Parameters | 5 |

Tests, fixtures, and generated code need a separate consumer-owned override.
The recommended starting test profile is 800 file lines, 250 function lines,
complexity 30, nesting depth 5, and 6 parameters. Generated and vendored output
is excluded rather than waived line by line.

## Activation evidence

The profile became blocking in Foundation only after:

1. Splitting every existing production violation without a grandfather baseline.
2. Adding positive and negative preset fixtures and dogfooding the preset here.
3. Proving the packed preset in a synthetic consumer without importing
   consumer-specific paths or architecture into Foundation.
4. Routing temporary exceptions through suppression governance with an owner,
   reason, exact rule and path, and expiry. Permanent inline disables are not an
   exception mechanism.
5. Keeping every external consumer disabled until it enables the published
   preset in a separate reviewed adoption change.

The likely first refactor boundaries are local-mode recovery state,
installation verification, and attach/detach link transactions. This is a
candidate decomposition from the dry run, not an accepted domain boundary.
