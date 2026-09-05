# Portable Documentation Consumer Inventory

Status: preparation only. This inventory does not authorize publication or
consumer mutation and does not claim new-only cutover is complete.

Snapshot: 2026-09-05, 17:15 UTC. Read-only `gh api` inspected the exact commits,
package manifests, integration records, and workflow blobs below. Preparation
visibility was last inspected with `gh pr list --state open` on 2026-09-04.
This supersedes the incomplete 2026-09-03 code-search result that identified
only the orchestrator. These are observed consumer coordinates, not a second
package-version authority or a release dependency graph.

## Verified consumer snapshot

All repositories below belong to `agent-teams-ai`. Docs and Foundation columns
report exact root `package.json` pins.

| Repository | Exact inspected commit | Docs | Foundation | Integration |
| --- | --- | --- | --- | --- |
| agent-runtime | `245dcb05206b53f7727786d5a94236350e5ca194` | 0.4.1 | 0.21.0 | stable10, managed |
| agent-teams-orchestrator | `95f2501afc1027bbba759ea3adaae1d4eeac1f86` | 0.4.1 | 0.21.0 | stable10, managed |
| agent-teams-platform | `2fc050f9e9583f6a4c4ed8c7cbb48d9e6f322acf` | 0.4.1 | 0.21.0 | stable10, managed |
| extension-foundation | `3e25b748991f296c3ae0d19219afbb689e0755fd` | 0.4.1 | 0.21.0 | stable10, managed |
| docs-protocol-canary-20260817 | `d82ced4de8f1028bf674bf149b0c823a6ef9fc11` | 0.3.2 | 0.20.0 | stable9.1, managed |
| agent-teams-token | `370c3aac97e4b3ddc7fcc9ada762a050580d0f39` | 0.2.0 | 0.20.0 | stable8, managed |
| get-modular | `a53a36fcbd7ac7e80fed4a9dc5451b61b44310d3` | 0.4.1 | 0.21.0 | portable, no managed integration profile/state |

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

## Required Foundation CI observation

**Consumer adoption requires a blocking Foundation check on every pull request.**
A package pin or workflow file alone is insufficient. The merge rule must
require the actual check context, and the invoked command must include the
governed Foundation checks without an optional step or ignored failure.

Read-only branch-protection and effective branch-rule API reads at 17:15 UTC
were compared with the exact workflow and package scripts above:

| Repository | Foundation execution in inspected source | Required merge context observed |
| --- | --- | --- |
| agent-runtime | `ci.yml`: `pnpm check` includes `foundation:check` | `check`, ruleset `19979781` |
| agent-teams-orchestrator | `architecture.yml`: `pnpm check` includes `foundation:check` | `architecture`, ruleset `19979784` |
| agent-teams-platform | `architecture.yml`: `pnpm check` includes `foundation:check` | Unknown: both protection APIs returned HTTP 403 |
| extension-foundation | `ci.yml`: `pnpm check` includes `foundation:check` | `check`, ruleset `20807525` |
| docs-protocol-canary-20260817 | No root Foundation check script; docs workflow is present | Only `docs-protocol / docs-protocol-check`, ruleset `20946477` |
| agent-teams-token | `ci.yml`: `pnpm check` includes docs, lint, types, and tests; no Foundation invocation | Unknown: both protection APIs returned HTTP 403 |
| get-modular | `ci.yml`: direct Foundation check and `pnpm check` includes `foundation:check` | `check (ubuntu-24.04)`, `check (macos-15)`, `check (windows-2025)`, ruleset `21807869` |

The four observed Foundation-required rulesets require strict status checks.
Their legacy branch-protection endpoint returned 404, while effective rules
were present; that 404 must not be interpreted as an unprotected branch.
The two 403 responses reported a GitHub plan restriction, not a successful
observation of absent rules. Their enforcement remains unverified.

These observations establish configured execution and merge requirements for
the inspected versions. They do not prove a successful run of the hardening
release, protection against policy weakening, or absence of privileged bypasses.
Before rollout, add and require the missing Foundation path for the canary and
token consumers, resolve the two unverified enforcement states, and qualify
the final migration commits. The docs-only required context is not accepted
as evidence of Foundation architecture coverage.

## Evidence limits and preparation status

No prepared new-only migration PR was identified in the 2026-09-04 open-PR
listings for these seven repositories. This is a dated observation, not proof that private
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
