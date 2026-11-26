# Findings baseline write safety

Status: baseline correction merged in PR #481; postmerge native qualification
identified the bounded Windows fixture follow-up below.

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
Include the companion FMS patch intent: its canonical packed manifest retains
the exact Foundation development dependency. Even though the compatible peer
window stays unchanged, the next Foundation version changes those published
manifest bytes and therefore requires a new FMS version.

## Critique and evidence record

- Round 1: independent filesystem/concurrency reviewer accepted the bounded
  ownership and reuse. Incorporated explicit barrier retention after physical-root
  observation failure, a held-lease CLI case that actually changes bytes, foreign
  temporary substitution, and a process barrier that accepts early lease refusal.
- Round 2: independent filesystem/concurrency reviewer approved the revised
  plan at `e9ccdac950376a777939bc7683bd649a114918e3`; no further design blocker.
- The two maintained native regression tests both fail against the unchanged
  pre-fix build on Node 26.11.1: foreign-file loss (`ENOENT`) and a second stale
  writer incorrectly returning success. They use real processes/files and no sleeps.
- Implementation: the same two regressions now pass. The complete focused native
  filesystem and public CLI suite passes 18/18 on Linux / Node 26.11.1, with no
  failures, cancellations or skips. Strict TypeScript 7.0.2 checking of the test
  project passes. The existing CLI fixture receives one bounded legacy JavaScript
  test; the new process fixture and native suite are ordinary strict TypeScript.
- Independent filesystem/concurrency review approved source
  `e66cb88f33294b4ac58f90387ccbbf3260e9304e`, including an independent 11/11
  native filesystem run. The repository fast gate and workflow-security checks
  pass. [PR #481](https://github.com/agent-teams-ai/engineering-foundation/pull/481)
  owns the final complete native CI, coverage and actual-main delivery receipts.

## Postmerge Windows containment fixture follow-up

Source: `8432a9737486384f894436bfd9242500e422fa5a` (the reviewed tree
from #481). [Main CI 45871183163, attempt 1](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/45871183163)
finished with 32 successful jobs and one primary failure, Windows D, propagated
to `windows-check` and `full-ci`. Its unchanged
`contains descendants of a non-Node Windows command` case rejected with
`ProcessTimeoutError` after 5059.6157 ms against its 5000 ms execution limit.
The exact delayed phase is not established. The same reviewed source tree passed
that case before merge; this does not prove an external infrastructure fault.

### Bounded correction and retained contract

The fixture already permits 30 seconds for PID readiness, uses a 45-second
Windows process deadline in its timeout case, and has a 65-second outer budget.
The two positive parent-exit cases still use a separate five-second Windows
execution allowance. Only the non-Node case was observed failing; the other
case is aligned with the same positive-containment budget, not a second
reproduced failure. Align those two requests with the existing
`PROCESS_DEADLINE_MS`: 45 seconds on Windows and the unchanged one second on
other platforms. The correction has two test-line replacements and no production,
workflow, dependency, version, inventory or published artifact changes.

These cases qualify successful parent exit and descendant containment, not a
five-second launch-latency commitment. Both must still resolve successfully;
a timeout or process failure remains a test failure. Keep the PID readiness
bound, three-second process-tree disappearance check, outer timeout, cleanup,
existing platform selection and all assertions unchanged. The long-lived child
still outlives the execution allowance if containment does not terminate it.
The readiness and execution budgets overlap because execution starts before
PID waiting; they do not allow 75 seconds in sequence. The existing independent
timeout, cancellation and launch/cleanup failure cases remain selected and must
pass in the same native suite. This does not add named mandatory identities or
change the existing mandatory-verifier contract. Do not add sleeps, retries, skip allowances or a timeout-error
success path. Do not infer a production process-runner defect or change its
deadline semantics from this fixture failure.

This is narrow maintenance of an existing `.mjs` test: migrating the complete
legacy process fixture would expand the correction. It adds no new JavaScript
responsibility and leaves that existing type-coverage gap explicit. No Changeset
is needed for this test-only correction.

### Delivery and evidence

The local installation terminated before qualification and its executor became
unavailable. Run the remaining authoring commands in a separate temporary
qualification branch with fixed commands and a full-SHA source checkout. Keep
that helper outside the target PR, with pinned Actions/runtime inputs, no
arbitrary-command inputs, no secrets, no remote writes and no publication.
Selected cleanup may write only the disposable test file; require unchanged
source bytes afterward. Run the existing built successor CLI
`agent-workflow check-changed --consumer . --base <source-main-SHA>` with its
normal Node 24 fixture and managed-tool prerequisites. Its mutable result remains
feedback-only. Record the helper and source identities separately; the final
ordinary PR/main full matrix below retains qualification ownership.

1. Publish this plan and obtain two independent critiques before changing the
   two execution allowances; record any accepted correction here.
2. Run the existing focused process-runner suite on Linux and preserve its
   intentional Windows-only skips. That run cannot qualify Windows behavior.
3. Run explicit-file cleanup, changed/fast/workflow-security checks and obtain
   an independent source review. Keep the full test inventories unchanged.
4. Request the normal complete final-head/base CI once; require actual Windows
   D execution of both parent-exit cases and its mandatory verifier, all native
   lanes, coverage and required CodeQL. A further failure requires diagnosis,
   not an automatic increase or rerun.
5. Merge through the ordinary owner route and verify actual-main CI and CodeQL.
   Any generated release candidate must follow its normal current-main owner
   handoff; this follow-up does not authorize publication of the combined release.

Review status: independent process-lifecycle critique of
`26bc67c3365b2139ebb0f986e7f996a47d681a94` accepted the two-line design.
It required the single-observed-failure distinction, overlapping budget
explanation and precise suite/verifier wording above. Independent native-test
review approved the revised plan at
`10d5233360b855d766b07e379a3825b4539606c0` before implementation. Both reviews
retained real descendant termination, finite budgets and ordinary final CI.
Implementation changes only the two planned execution-allowance expressions;
executable qualification and final source review remain pending. Open PR #483 owns Effect browser qualification; #468 owns an optional
test-integrity preset, and #469 owns CI concurrency/quality work. Their source
owners and branches are not part of this bounded fixture correction.
