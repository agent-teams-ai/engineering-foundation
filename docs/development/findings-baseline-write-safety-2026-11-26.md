# Findings baseline write safety

Status: implementation plan; source review and qualification pending.

## Outcome and scope

Keep `baseline prune` shrink-only when supported commands operate concurrently,
and never remove a temporary file that the current write does not own. The owner
is the existing findings-baseline filesystem adapter. Its JSON Lines format,
CLI, producer, and pruning policy remain the same.

Source basis: `2d0a0fff14b758cb11a16fd9fc4e87ec9f71f2a8`.
The two unchanged-source native witnesses reproduced on Node 24.22.3 are:

1. An existing PID-named temporary makes exclusive creation fail with `EEXIST`,
   but the unconditional cleanup removes that other file.
2. Two real processes observe count 3. The first writes count 1; the second
   then writes count 2. Both report success, losing the first prune.

The second witness controls scheduling through the existing read port while
using real filesystem writes, synchronization and rename. It is adapter evidence,
not a completed CLI or native-platform qualification.

## Bounded design

Reuse the public Repository Mutation Node mechanisms already depended on by
Foundation: `acquireMutationLease`, `observeMutationState`,
`retainMutationBarrier`, `retainMutationBarrierOnEvidence`, `releaseMutationLease`, and
`observeAtomicFileReplacement`. Do not import another capability's private
adapter or add a transaction framework, journal, dependency, or public API.

The filesystem owner will:

1. Resolve and retain the actual root/parent/target identity using the existing
   path policy and atomic-replacement observation.
2. Acquire the existing cooperative repository mutation lease before the final
   expected-byte check and hold it through promotion and finalization.
3. Reject active/interrupted common mutation evidence; recheck the original
   expected bytes and refuse a changed baseline through the existing typed
   input-error boundary.
4. Prepare and publish only its owned sibling temporary with identity checks.
5. Attempt identity-aware cleanup, physical-root observation, barrier retention
   and lease release even if an earlier finalization step fails. Preserve every
   failure and distinguish a possibly completed replacement from no effect.
   If physical-root observation fails, explicitly retain the mutation barrier;
   inspecting common evidence alone cannot establish a substituted root's identity.

The guarantee is serialized supported cooperative writers and atomic visibility.
An arbitrary editor that ignores the lease is outside that concurrency guarantee.
This work adds no power-loss durability claim, automatic stale-lock takeover,
retry, schema/profile migration, or cross-repository rollout. `create` retains
its existing exclusive-create behavior; no unrelated refactor is included.

## Verification and acceptance

Use the existing native filesystem and CLI fixtures. New maintained source and
tests use ordinary `.ts` and the required TypeScript 7.0.2 route.

| Case | Required observation |
| --- | --- |
| Ordinary replacement, including a root-level baseline | Exact expected successor bytes; resources and lease released |
| Existing foreign temporary or substitution of the owned temporary | Foreign bytes survive unchanged; substituted owned path is refused |
| Two real writers starting from one baseline | At most one stale-preimage write succeeds; no raised/reintroduced entry |
| Changed expected bytes | Typed conflict; current baseline preserved |
| Held lease or interrupted common evidence | Refusal before publication; existing owner's evidence preserved |
| Write/promotion/finalization failure | Owned cleanup only; later finalization still attempted; no false no-effect result |
| Final physical-root observation fails | Original failure preserved and mutation barrier retained; no clean release |
| Existing public CLI init/prune/check | Original shrink-only and input-error behavior retained |
| Real CLI while mutation lease is held and prune needs a write | Nonzero typed refusal and unchanged baseline; normal command works after release |

Bind new portable tests into the existing strict project and Linux/Windows
inventories; use the adopted native matrix and coverage authority. Fault seams
remain narrow, preserve real filesystem effects, and use explicit barriers rather
than sleeps. The original implementation must fail the new bug witnesses.
The concurrent-process harness accepts a second writer's early lease refusal
before its read callback, then releases the first writer; it must not wait for
two reads after serialization is fixed. A no-op prune remains read-only and may
succeed while a lease is held. Existing Repository Mutation tests retain ownership
of low-level open/write failure qualification.

## Estimate and delivery

Incremental handwritten scope: 150–260 production/integration lines, 250–450
test/fixture lines, and approximately 30–70 lines of inventory, documentation
and Changeset work. Existing mechanisms are reused, not counted again.
Complexity 4/10, expected reliability within the cooperative-writer scope 8/10,
estimate confidence 7/10; roughly 2–4 focused engineer-days, not a calendar promise.

1. Publish this plan on the task branch and retain two critique rounds below.
2. Implement the bounded adapter correction and discriminating tests; publish
   each source commit immediately.
3. Run focused native/CLI checks plus changed, fast and workflow-security gates.
4. Obtain independent current-head technical review and request the complete
   exact-head/base `full-ci` matrix once the source is ready.
5. Resolve findings, squash merge through the authorized owner route, and verify
   the actual main commit and applicable postmerge checks.

Use the normal patch Changeset. Publication remains owned by the existing
release stream; this task does not rewrite its branch or change versions.

## Critique and evidence record

- Round 1: independent filesystem/concurrency reviewer accepted the bounded
  ownership and reuse. Incorporated explicit barrier retention after physical-root
  observation failure, a held-lease CLI case that actually changes bytes, foreign
  temporary substitution, and a process barrier that accepts early lease refusal.
- Round 2: pending review of the revised plan and explicit rejecting cases.
- Implementation, independent review, native CI and main evidence: pending.
