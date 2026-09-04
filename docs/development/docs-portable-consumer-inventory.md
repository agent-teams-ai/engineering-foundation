# Portable Documentation Consumer Inventory

Status: preparation only. This inventory does not authorize publication or
consumer mutation and does not claim new-only cutover is complete.

Snapshot: 2026-09-04. Read-only `gh api` inspected the exact commits below;
`gh pr list --state open` inspected preparation visibility on the same date.
This supersedes the incomplete 2026-09-03 code-search result that identified
only the orchestrator. These are observed consumer coordinates, not a second
package-version authority or a release dependency graph.

## Verified consumer snapshot

All repositories below belong to `agent-teams-ai`. Docs and Foundation columns
report exact root `package.json` pins.

| Repository | Exact inspected commit | Docs | Foundation | Integration |
| --- | --- | --- | --- | --- |
| agent-runtime | `6f5f68d899ba68ad767760e642befd72188e666b` | 0.4.1 | 0.21.0 | stable10, managed |
| agent-teams-orchestrator | `5768a6465cdcce37a599bca4c60cc94fa967f327` | 0.4.1 | 0.21.0 | stable10, managed |
| agent-teams-platform | `2fc050f9e9583f6a4c4ed8c7cbb48d9e6f322acf` | 0.4.1 | 0.21.0 | stable10, managed |
| extension-foundation | `3e25b748991f296c3ae0d19219afbb689e0755fd` | 0.4.1 | 0.21.0 | stable10, managed |
| docs-protocol-canary-20260817 | `d82ced4de8f1028bf674bf149b0c823a6ef9fc11` | 0.3.2 | 0.20.0 | stable9.1, managed |
| agent-teams-token | `370c3aac97e4b3ddc7fcc9ada762a050580d0f39` | 0.2.0 | 0.20.0 | stable8, managed |
| get-modular | `0f7d2fc64ae7258781e6c2676ca1e0ccc377f418` | 0.4.1 | 0.21.0 | portable, no managed integration profile/state |

For the first six repositories, exact-revision reads verified these raw fields:

- `architecture/foundation/docs-consumer-integration.json`: `schemaVersion: 2`,
  `cohort.schemaVersion: 1`, and the package pins shown above;
- `architecture/foundation/docs-protocol-managed-state.json`: `schemaVersion: 1`;
- `architecture/foundation/docs-protocol-qualification.json`: `schemaVersion: 2`.

The full Cohort IDs are `docs-2026-08-31-stable10`,
`docs-2026-08-28-stable9.1`, and `docs-2026-08-28-stable8`, respectively.
Raw profile schema 2 must not be conflated with its embedded Cohort v1 or the
new-only profile v3 target. For get-modular, the complete recursive tree and
exact-path reads show no managed integration profile/state or qualification
contract; portable package use does not imply managed adoption.

## Evidence limits and preparation status

No prepared new-only migration PR was identified in the open-PR listings for
these seven repositories. This is a dated observation, not proof that private
plans, local branches, drafts outside the inspected repositories, or later work
do not exist. No consumer checkout, runtime, command, or test was executed.

The historical persisted-transaction and recovery-generation inventory remains
**unknown** for every consumer. Committed-file inspection cannot establish
absence of local journals, quarantined/retired evidence, or in-flight work.
Exact current heads, clean worktree proof, legacy imports/entrypoints, and
admitted recovery artifacts must be rechecked before authorized migration.

## Required migration inputs

Before publication, prepare and review intended exact target coordinates,
new-only import/CLI changes, managed-adapter placement where applicable,
required-check plans, recovery instructions, and rollback criteria against the
inventoried consumer commits. Bind these plans to reviewed packed artifacts;
do not require not-yet-published registry evidence to prepare the plans.

After publication, but before consumer adoption, bind the approved plan to
actual immutable registry versions, SHA-512 SRI, signatures/provenance, and the
final registry-resolved lockfile diff. Verify required consumer checks and
recovery compatibility at each exact migration head. Intended coordinates or
prepublication lockfile plans are not substitutes for this final proof.

The accepted package boundary and release graph remain in
[ADR-0043](../decisions/0043-new-only-portable-documentation-package-boundary.md)
and manifest-derived release evidence. No bridge, runtime autodetection,
floating range, or automatic migration is part of this preparation.
