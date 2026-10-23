# Feature Module Standard with Foundation 3

Status: companion source preparation. No Foundation 3 registry publication or
installed Foundation 3 runtime qualification is claimed by this record.

## Why the peer window expands

The optional `@agent-teams/feature-module-standard/node` entry uses exactly two
Foundation public ports:

- `@agent-teams/engineering-foundation/source-graph`: `observeSourceGraph`,
  including files, edges, parse failures, unresolved literal targets and
  unresolved runtime references;
- `@agent-teams/engineering-foundation/ratchet`: `checkBudgets`, including
  measurements, thresholds and warning results.

The planned Foundation 3 break relocates presets and changes quality coverage.
Neither is consumed by this runner. The pure root and `./fixtures` entries
continue to need no Foundation installation. No runtime or declaration code in
Feature Module Standard changes for this peer expansion.

The preparation checkout is based on `c7344dfc82afb0639027adf350f092cd21d14d48`,
with source manifests FMS 0.2.2 and Foundation 2.1.0. Current upstream was checked
at `0e0de78d4c2089be8effc37da4cfd70eab22358c`, whose source manifests are FMS
0.2.3 and Foundation 2.1.1. The public source-graph and ratchet entry files,
source observation use case and FMS Node composition file are byte-identical
between those revisions. The private budget threshold identity delimiter differs;
this record makes no claim that every Foundation implementation byte is identical.
The actual installed-consumer corpus remains the behavior check.

## Consumer migration

1. Upgrade to the new FMS 0.x minor that publishes the optional peer range
   `^1.8.0 || ^2.0.0 || ^3.0.0`. Do not reuse or mutate an existing npm version.
2. When adopting Foundation 3, update its exact consumer pin and lockfile in the
   same migration as the Toolchain preset, script and quality-profile changes.
   Existing Foundation 1.8+ and 2.x consumers can retain those versions.
3. Run the consumer's existing FMS conformance and real Node runner checks with
   strict peer dependencies enabled. No peer override, force installation or
   accepted-integrity substitution is part of this migration.

The source manifest stays on its actual version until Changesets prepares the
release. The minor Changeset determines the next 0.x train, including after
rebasing onto the newer upstream patch. Released API baselines and the retained
published-minimum archive integrity remain unchanged.

## Qualification and remaining release condition

The existing `tests/pack-publish-manifest.test.mjs` checks the official
Changesets plan/version operation in disposable fixtures, accepted and rejected
peer bounds, and real offline npm strict-peer installation of metadata fixtures.
Those fixtures prove package-manager compatibility rules, not Foundation 3
runtime behavior.

The existing packed FMS consumer in `scripts/packed-feature-module-standard.mjs`
installs the caller's exact qualified current Foundation archive and the exact
published Foundation 1.8.0 minimum separately. It typechecks public entries and
checks materialized-source parity, module composition, runtime/type-only
republication, unresolved and malformed inputs, budget warnings and closed deep
imports. The direct Foundation peer is never overridden. Pure entries are also
tested with no Foundation present. The minimum's existing registry SRI remains
authoritative.

Before publication and Get Modular migration, rerun that unchanged behavior
corpus against the actual final Foundation 3 archive and newly versioned FMS
archive through the protected package-qualification route. Require the
installed Foundation identity and version, same Foundation resolution from the
consumer and FMS, strict peers and both native/public API gates. A passing
Foundation 2 candidate or synthetic peer fixture does not satisfy this final
Foundation 3 condition. First Toolchain publication remains the prerequisite
for the coherent Foundation 3 train.
