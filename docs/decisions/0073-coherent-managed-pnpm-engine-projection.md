---
id: ADR-0073
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0073: Coherent Managed pnpm Engine Projection

Status: Accepted after independent technical review by the repository architecture
coordinator. Canonical accepted-decision promotion records this bounded runtime
projection authority; complete native and package qualification remain separate.

Decision owner: Product owner; the repository architecture coordinator records
the bounded decision after independent technical review.

Date: 2026-10-29.

## Scope and owner

Add one narrowly bounded field to ADR-0070's managed generation runtime write
inventory. Preserve ADR-0070 and all other accepted decision bytes. The existing
Docs Protocol Agent Teams consumer-integration owner and Repository Mutation
writer keep their existing responsibilities; no package, module, public API,
schema, manager framework or Host callback is added.

## Decision

When the managed generation projector selects the exact pnpm runtime11.20.0,
write root `packageManager` as `pnpm@11.20.0`. If root `engines.pnpm` is already
declared, project that field to the same exact `11.20.0` from the same selected
constant. Preserve an absent `engines.pnpm`: `packageManager` already selects the
exact manager, and no conflicting engine policy exists. Do not change any other
engine field except the already owned, actually selected `engines.node`.
Preserve every unrelated manifest byte, including formatting. This authorizes
no arbitrary engine migration or broadening of an engine range.

The target archive receives this deterministic manifest before its strict
`installCohort` call and target integration reconciliation. A Host cannot repair
the conflict afterwards: an exact source `engines.pnpm: 11.18.0` rejects the
selected target manager11.20.0 before reconciliation runs. Keep engine-strict,
real runtime observation, frozen/offline installation, existing lock authority
and lifecycle restrictions unchanged. No engine spoof or fallback is permitted.

Existing deterministic postimage validators must recompute the same owner
projection and reject foreign manifest edits. Original and committed restoration
continue to select and authenticate the retained original whole-file bytes;
they restore the original engine value or absence exactly. They do not derive an
original manifest by guessing an inverse manager projection.

## Acceptance and qualification boundary

The repository architecture coordinator records this narrow technical decision
after independent technical review. The existing ADR index and ordinary
`architecture-decisions-promote-baseline` operation record its accepted authority.
This does not imply a fresh human review, edit the accepted ADR-0070 payload or
maintain a second baseline. The adapter behavioral correction ships as its own patch artifact,
without an Engineering Foundation or Feature Module Standard release intent.

Qualification includes an exact11.18-to11.20 engine regression, preserved absent
field and unrelated bytes, selected Node behavior, strict pinned TypeScript,
and an empty offline TEST manifest proving real pinned pnpm rejects the old
conflict and accepts the corrected projection with engine-strict retained.
Those controls do not qualify a published adapter, actual enrolled Gen3
activation or a release. The final consumer tuple and retained controller
build/proof identities must bind the actual corrected published adapter and
complete installed forward, cold-resume and exact-original restoration evidence.
