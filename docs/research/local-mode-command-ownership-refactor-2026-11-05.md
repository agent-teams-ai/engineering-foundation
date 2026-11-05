# Local-mode custody and command ownership refactor

Status: implementation and review record; current qualification is tracked in [draft PR #466](https://github.com/agent-teams-ai/engineering-foundation/pull/466).
Date: 2026-11-05 (Europe/Kyiv).
Baseline: `942b616a4b79b9509a6a89d36205d7b1788d0928`.
Delivery: one new draft PR; no merge, package publication, or consumer upgrade is part of this task.

## Objective and admission

Prevent current Foundation command and local-development behavior from becoming
unsafe foundations for more commands and consumers. This is universal development
tooling: consumer paths, packages, architecture, and business policy remain
consumer-owned. Apply Clean Architecture, SOLID and DRY to the existing owners;
there is no business domain aggregate to introduce here.

The owner requested substantial work with a 10–15k changed-line guide, explicit
scope, strongest-model research, and repeated independent review. Three independent
researchers selected the two workstreams below over a larger rewrite of already
well-qualified Known-file recovery. The plausible initial estimate is 6–11k
meaningful changed lines, not a quota. Final measured additions/deletions will be
reported. No unrelated test migration, file movement, formatting, third package,
or new abstraction will be added to reach a line count.

The canonical organization Engineering Quality Standard and Governance were read
live before research. Repository AGENTS.md, ownership, existing ADRs, local-mode
and quality-gate contracts remain authoritative. Existing public contracts and
historical evidence are protected.

## Evidence and priorities

| Finding on the baseline | Why it matters | Selected owner |
| --- | --- | --- |
| `registry-recovery.ts` validates a backup and then recursively deletes the installed path; detach intentionally admits INVALID recovery states | A foreign replacement directory present before detach can be deleted without a concurrent race | Local package lifecycle and its Node adapters |
| `local-state-store.ts` opens a predictable temporary with `w`, publishes without retained temporary identity, and removes wildcard-matching temporaries | One invocation can overwrite or clean evidence it does not own | Local state persistence |
| Local attach/detach release in `finally` can replace an earlier failure | Recovery diagnostics lose the operation that first failed | Local lifecycle settlement |
| The CLI parser respects `--`, but the failure path rescans raw argv for JSON flags | A positional `--json` changes error format despite not being admitted as an option | Existing command-host feature |
| Declaration lookup, command admission, effects, rendering and exit state are interleaved in the CLI adapter | Each new command can duplicate interpretation and failure decisions | Command-specific application handlers and the existing Node adapter |

These are source-backed findings. Initial implementation first establishes
focused failing tests for the destructive restoration and argv-terminator cases.
Static evidence is not yet a claim of executed regression qualification.

## Alternatives reviewed

Scores are engineering judgments; higher risk/complexity is worse.

| Option | Value /10 | Risk /10 | Complexity /10 | Decision |
| --- | --- | --- | --- | --- |
| Local custody plus bounded command admission/result ownership | 8–9 | 6 | 5–6 | Selected by all three independent scope critics |
| Private Known-file state constructors across the recovery engine | 6–7 | 7–8 | 6–7 | Defer: useful extension debt, but current crash/foreign-file oracles are strong and no corruption defect was established |
| Add Stack Toolchain configuration admission to this PR | 7–9 | 7 | 6–7 | Exclude: third independent owner and no stronger selected guarantee |
| Generic filesystem/process/command framework | — | High | High | Exclude: no demonstrated need |

## Strict scope

### A. Local-mode physical custody

Affected production scope is
`packages/engineering-foundation/src/local-mode/`, with narrowly necessary
existing transaction-coordination composition integration only.

1. Keep lifecycle decisions in the current application owner and physical
   filesystem decisions in its Node adapters.
2. Observe the installed entry itself before restoration. An authentic backup
   cannot authorize deleting an unrelated destination.
3. Preserve expected local links with a valid marker, including dangling links
   to deleted checkouts, missing-entry recovery, already-restored registry
   entries, and the provable orphan-backup cases defined below.
4. Refuse foreign or ambiguous entries, preserving their bytes and recovery
   evidence. Never repair the defect by rejecting every INVALID status.
5. Use exclusive temporary creation and retain concrete identity through write,
   synchronization, publication, and cleanup. Cleanup is based on retained
   ownership, never a filename wildcard or matching contents.
6. Preserve original operation failure together with finalization/release
   failure, and release exactly once. Preserve the existing failure categories
   and retained recovery barriers wherever the established contract applies.
7. Keep public lifecycle port shapes, marker v1 bytes/meaning, old temporary-name
   recognition, and declared platform guarantees. Ephemeral observations are
   not new durable identity claims.

Physical observation stays operation-specific and private to local-mode Node
adapters. ADR-0051's closed physical-observation consumer set is not expanded.
Do not import that primitive through a wrapper or move local policy under an
admitted feature to evade the boundary. An existing public Mutation operation
may be reused only if its exact resource and recovery semantics fit. If the
implementation requires a new persistent contract or a broader primitive
consumer, return to this plan and the owning decision process before editing
that boundary.

The guarantee is cooperative custody with observed identities and conservative
refusal. Node path operations do not establish universal filesystem
compare-and-swap against arbitrary nonparticipating writers.

### Restoration evidence table

| Current entry / evidence | Required behavior |
| --- | --- |
| Expected local symlink/junction and valid registry backup | Restore through verified local-operation ownership; retain parent/entry observations through the effect |
| Expected local link whose target was deleted | Preserve existing supported detach recovery |
| Installed entry absent, valid backup | Restore only after current path/parent and backup admission |
| Already-restored expected registry entry | Idempotent completion under current semantic/physical evidence |
| Orphan backup, installed entry absent | Preserve automatic recovery after backup/parent admission |
| Orphan backup, independently proven already-restored registry state | Preserve idempotent completion without deleting an entry to infer ownership |
| Orphan backup, marker absent and installed local/foreign link still exists | Refuse automatic restoration; preserve link and backup for manual reconciliation |
| Foreign real directory or regular file | Refuse; preserve the replacement and retained recovery evidence |
| Foreign symlink/junction | Refuse; never follow it for cleanup |
| Invalid/escaping backup or changed dependency/consumer root | Preserve current rejection and evidence |
| Entry/parent/backup changes after observation | Refuse or retain uncertainty according to the existing physical boundary; do not report unobserved cleanup |
| Foreign or historical unowned state temporary | Preserve; existing manual-recovery recognition remains |
| Operation fails and release also fails | Preserve both observations; do not replace the first failure or claim settled custody |

Failed attach may deliberately remove its marker while retaining an orphan
backup/barrier. Existing recovery tests own this behavior; do not change it
merely to make an idealized state diagram simpler.

The missing-marker/existing-link case is an intentional safety correction to
previous automatic orphan recovery: marker v1 carries the expected local target,
and the backup cannot reconstruct that lost authority. The existing test that
deletes the marker after attach will assert refusal and byte/link preservation;
separate absent-entry orphan cases still prove automatic recovery. This is a
documented behavior restriction, not a new marker schema, guessed target,
duplicate durable journal, or removal of the test case. Record the migration in
the package change note and local-mode documentation. A known marker may record
DETACHING intent before restoration refuses; the marker remains retained rather
than claiming that failure implies no intent write occurred.

### Marker publication and retirement

Retain the recognized `foundation-link.json.*.tmp` name family, with fresh
exclusive names and no ownership inferred from that spelling. Initial marker
creation requires observed absence. Phase replacement admits the expected
predecessor marker fields/bytes and its current entry and parent; removal
requires an observation retained by this Node adapter's operation. A fresh
process must admit the on-disk predecessor before replacement; it cannot recover
an old in-memory ownership claim. Missing markers are idempotent absence, while
unproven existing markers/temporaries remain preserved.

Observe the published marker destination as well as its temporary. Qualification
includes destination substitution before phase replacement and removal, parent
or state-directory replacement, failure after rename before parent sync, foreign
temporary substitution before cleanup, and historical temporary refusal. The
Node implementation may retain operation-local observations behind unchanged
public write/remove ports; no global registry or restart-surviving memory claim.
Immediate pre-effect checks do not make path-based operations atomic conditional
updates against a nonparticipating writer.

### Local lifecycle settlement

| Operation | Finalization | Observable result |
| --- | --- | --- |
| Success | Success | Existing successful result |
| Failure | Success | Preserve original thrown value and category |
| Success | Failure | Preserve established finalization failure; no settled-success claim |
| Failure | Failure | `FoundationError(LOCAL_STATE_INVALID)` with ordered `AggregateError([operationFailure, finalizationFailure])` as cause; preserve nested causes |
| Cancellation | Failure | Same unresolved-local-state failure, text/JSON execution-failure exit 1; cancellation stays in the first cause |

Do not mutate frozen or foreign thrown objects. Non-Error thrown values remain
in the ordered cause list. Exactly one release attempt follows a successful
acquisition, including inspection failure; acquisition failure releases nothing.
Only this local lifecycle settlement changes; generic CLI error classification
and other transaction/process owners remain unchanged.

### B. Command admission and result ownership

Affected production scope is the existing
`packages/engineering-foundation/src/features/command-host/` and directly
involved existing composition callers.

1. One argv parser owns token consumption, output mode, and the `--` terminator.
   Preserve its admitted format decision for execution and failure.
2. Define malformed-input output semantics from the same parsing pass. A second
   raw-argument scanner, even with improved rules, is not an acceptable fix.
3. Keep a private static command set. Narrow command-specific dependency records
   and move the affected orchestration/output decisions behind the current
   application boundary where this removes duplicated knowledge.
4. Initially migrate only buffered local-mode results, check/quality reports,
   findings-baseline results, and information/help/schema/version output where
   admission/rendering ownership is duplicated. Use narrow command-specific
   dependency records behind the existing composition contract. Keep actual
   stdout/stderr writes and exitCode assignment in the outer Node adapter for
   these paths. Preserve delegated agent-workflow, quality-gate and scaffolding
   output, plus specialized policy/audit handling.
5. Preserve command names, aliases, valid option ordering, positional values,
   command-specific success/error reports, exit precedence and cancellation.
6. Public API audit keeps its specialized report and intentional exit code 2.
   Existing scaffolding, agent-workflow, and quality-gate owners remain explicit.

No public command bus, plugin registry, container, service locator, generic
domain-result union, new API surface, or wholesale rewrite of unaffected command
implementations. Constructor/global usage alone is not evidence for changing a
command; each extraction must remove a repeated admission/result responsibility.

### CLI admission cases

Retain positive behavior and independently assert stdout, stderr, envelope count,
and exit code for:

- positional `--json` and `--format` after `--`;
- valid format selection before a later parsing failure;
- malformed options before a format selection;
- option values whose spelling resembles another flag;
- existing repeated/conflicting format behavior;
- failures after invocation admission, specialized audit failures, and
  supported cancellation;
- ordinary check/status/attach/detach and delegated command smoke routes.

The parser performs one token-consumption traversal, retains the first parse
error, and continues only bounded lexical classification to recognize later
legitimate output options before `--`. This is recognized failure-output intent,
not execution admission of conflicting options. An invalid invocation never
constructs services, reads configuration, or starts command effects. A valid
scalar value is consumed exactly once; a flag-shaped token rejected as a scalar
value remains available to that same traversal. The command token is never
reinterpreted as an output option.

| Arguments after command | Required failure format / precedence |
| --- | --- |
| `--unknown --format json` or `--format json --unknown` | One JSON error; unknown option remains first error |
| `--unknown --format text` | Text error |
| `--consumer --json` | JSON error for missing consumer value |
| `--config --format json` | JSON error for missing config value |
| `--format xml --json` | JSON error for the first invalid format |
| `--format text --json` or `--json --format text` | JSON error for duplicate/conflicting format selection |
| `--format json --format json` | JSON error for duplicate format |
| `--format text --format text` | Text error for duplicate format |
| `-- --json` or `-- --format json` | Text unless an earlier real option selected JSON; tokens are positional |
| `--unknown -- --json` | Text error for the unknown option |
| `--format json -- --json` | JSON requested by the earlier real option |

Preserve aliases and command-prefix semantics (`repo check`, `gate run`, help
and version) in the same parser. Intentional corrections are positional tokens
after the terminator and previously reinterpreted command/value text; existing
legitimate JSON requests on malformed invocations retain JSON transport.

Audit parsing failures use the generic error envelope. An admitted public API
audit service failure or cancellation keeps the audit-specific object and exit
2; successful audit output and its result-selected exit code are unchanged.

Retain the existing generic failure renderer and its lazy observation order:
text publishes before reading the classified exit code, and a failed write
prevents later observation. Existing hostile-error/write-failure tests remain
independent oracles. Do not eagerly turn this path into `{text, exitCode}` or
weaken its tests to fit a new buffered-success abstraction.

## Exclusions and retained findings

- No changes to Known-file Plan admission, journal v1/envelope v6, recovery,
  receipt digests, exact-build checks or historical schemas.
- No Stack Toolchain configuration refactor, Docs query/metadata rewrite,
  generic process supervision, launcher cancellation migration, or test-runner
  consolidation.
- No extension of closed physical-identity primitive admission, package
  relocation, dependencies, feature flags, FMS contract or consumer architecture.
- No changes to release-owned baselines or historical accepted ADR bytes.
- No release PR #464 mutation; no overlap with dependency research PR #458.
- No qualification scope, mandatory identity, platform matrix, timeout,
  suppression, coverage floor, or archive-limit reduction.

The deferred Stack top-level configuration read can block on a FIFO and is
unbounded before parsing. Packaging immediate-abort handling and dispatcher
cancellation also merit separate bounded work; existing prior research records
their lifetime constraints. Deferral is explicit and is not a claim that all
repository debt is eliminated.

## Implementation sequence and ownership

1. Finish independent plan review, resolving safety/compatibility and excess-scope
   findings. Run a second plan review of the corrected concrete design.
2. Establish the focused red cases with actual public local-mode/CLI routes and
   disposable filesystem fixtures on admitted runtimes.
3. Implement lane A and lane B in separate owned file sets. Keep changes in this
   one branch/PR and preserve a reviewable commit history.
4. Migrate substantially rewritten tests/helpers to ordinary strict `.ts`;
   retain frozen or syntax-sensitive fixtures. Update exact test manifests,
   coverage/source membership and packaging inventory only for actual changes.
5. Build and use Stack's explicit-file cleanup for task-owned JS/TS only.
6. Run meaningful focused and installed-consumer qualification, required changed,
   fast, and workflow-security gates. Publish each commit immediately.
7. Run independent implementation critics across correctness/custody,
   architecture/contracts, and scope/E2E. Fix actionable findings, then repeat
   review of the changed evidence until none remains.
8. Run the full native matrix on the final draft head/base to qualify affected
   Linux/Windows/macOS boundaries. Keep the PR a draft as requested.

Root owns branch/commits/push, shared inventories, generated projection freshness,
PR metadata and external workflow operations. Parallel implementers receive
disjoint ownership; no agent cleans or reformats another agent's files.

## Verification and acceptance

Focused tests establish behavior, not the new implementation's shape. Reuse
existing independent expected values and recovery fixtures. Add unit tests only
for high-risk pure admission/settlement decisions; prioritize public service,
real filesystem, installed CLI and native platform routes.

The real consumer route is a disposable checkout of
`agent-teams-ai/.github` at
`0b44c64c824f536bd1b085341e7669bcc64ef124`, observed with exact Foundation
3.0.0 and pnpm 11.18.0. Respect that consumer's own rules and frozen install;
record the candidate archive identity and unchanged manifest/lockfile digests.
Install the candidate CLI in a separate disposable tool root, then exercise
its public status/registry and local-mode routes against the real checkout.
The explicit local target may be the reviewed built candidate checkout, as
local attach is designed to select one; the CLI executable under test must come
from the qualified archive. No external repository writes, pin upgrade,
publication or full-consumer conformance claim follows from this bounded probe.

Retain the complete local-mode, registry rollback, dead-checkout, operation-lock,
Bun registry-only, transaction-barrier and command-specific suites. Installed
tarball local mode and CLI probes must use the exact candidate packages in
ordinary disposable consumers, without workspace source fallback. Preserve
historical fixture bytes, package exports, public type checks, phase order and
artifact custody.

Required commands are the repository's admitted Bun/Node routes:
`bun tools/dev.mts check:changed`, `bun tools/dev.mts check:fast`,
`bun tools/dev.mts security:workflows`, focused checks and the complete explicitly
requested `full-ci`. Node 26.11.1, Bun 1.4.3, exact pnpm 11.20.0 and TypeScript
7.0.2 are retained. Node 24 generation2 execution uses its existing explicit port.

Local environment limitations are recorded honestly. Native evidence must match
the final head/base and complete inventories; no prior SHA or incomplete local
run is relabeled as current qualification. No merge is authorized by this new
draft-only task.

Acceptance requires: demonstrated red-to-green selected defects; preserved
legitimate recovery and public output contracts; no new shared framework or
primitive-admission expansion; all changed maintained code under strict checking;
complete native evidence; independent critics with no remaining actionable
findings; final diff size and any remaining bounded debt recorded.

## Review log

- Research and scope selection: three independent roles unanimously selected
  local custody plus bounded command admission, and rejected a third Stack lane
  or a size-driven Known-file rewrite.
- Detailed plan round 1: three critics requested explicit orphan authority,
  marker destination custody, combined-error semantics, and malformed-argv
  output rules. The revised plan records conservative orphan-link refusal,
  destination/predecessor observations, ordered local settlement, one-pass
  failure intent, preserved lazy reporting, and an exact real consumer route.
- Detailed plan round 2: APPROVED by all three independent roles (local custody
  and compatibility; CLI admission/failure contracts; portable contracts and
  scope/E2E). No remaining plan blocker. Approvals cover the concrete revised
  boundaries above, not implementation or runtime qualification.
- Implementation round 1: critics found and reproduced eager/unbound report
  rendering, exact-byte admission of otherwise equivalent v1 marker JSON,
  recovery-diagnostic precedence, and custody loss across publication sync. The
  owners corrected these findings and added focused regression evidence; the
  pre-existing reporting oracle remains unchanged.
- Implementation round 2: independent custody/compatibility and CLI/installed-E2E
  reviewers approved the corrected behavior. CLI review independently passed
  all 12 new admission/result cases and 75 retained reporting-observation cases.
  The integrated 213-case focused run passed 212 cases; its sole failure and the
  fast gate identified the same adapter-to-reporting architectural edge. Final
  integration also identified six typed-lint findings. The correction moved
  failure construction to the existing local application owner and removed
  redundant narrowed conditions; no dependency permissions or suppressions were
  added.
- Implementation round 3: an independent critic reproduced two same-operation
  rollback defects after forward replacement had already detected substitution:
  replaced installed parents and a new link with identical target text. The
  correction retains expected installed entry/absence, both parent observations,
  and published backup through rollback. Both public regressions were RED before
  the change and GREEN afterward; the author's complete local batch passed all
  85 cases. Fresh detach still admits durable evidence in its new operation.
- Final committed-head review, complete native matrix, scoped real-consumer
  proof, final diff size, and the disposition of the integration findings will
  be recorded in the draft PR. Evidence from a mutable working tree is not
  current-head qualification.
- Native qualification follow-up: dead-code checking identified three unused
  private exports, removed without suppressions. Packaging required exact
  inventory reenrollment for the eight new production modules: 32 normal compiler
  outputs increase Foundation's fixed census from 2,935 to 2,967. Two independent
  researchers verified that subtracting precisely those outputs restores the
  previous full membership digest and approved the two-file census successor.
  The test retains that historical digest, every older census layer, and the
  one-extra-member rejection. The generic 2,500-entry bound, all payload byte
  limits, the decompression formula, path policies, manifests and historical
  fixtures remain unchanged.
  This is required membership qualification of the selected implementation;
  fresh archive execution and current-head native evidence remain required.
- The complete native test inventories exposed two retained fixed expectations
  that also needed synchronization: Windows mandatory-case positions after the
  four new suites, and the exact adapter builtin list after admitting crypto and
  filesystem observations. Independent critics verified the new literals; exact
  ordering, inventory unions, empty application/facade builtin lists, and all
  dependency fences remain enforced.
- Native installed-E2E follow-up found that the dangling-target fixture copied
  pnpm's package-root `node_modules` before creating its own dependency link.
  An initial exact-directory copy exclusion passed Linux and macOS qualification,
  but Windows exposed the synthetic link's incomplete dependency resolution.
  The corrected fixture makes a fresh sibling clone of the complete installed
  package, preserving both package-owned modules and normal ancestor lookup.
  Three critics approved removing the exclusion and manual dependency bridge.
  Only the returned owned clone is removed to make the local link dangle;
  physical CLI binding, backup custody, and recovery assertions remain intact.
  There is no production, protocol, or package-census change.

## Follow-up: retained marker authority and duplicate-lease settlement

A fresh review of PR #466 found three preliminary findings in
[ReviewRouter comment 6647361803](https://github.com/agent-teams-ai/engineering-foundation/pull/466#issuecomment-6647361803)
that remained present in `bfd8aaa3e2d9d997cdaaca9a853cf80fc64467c0`.
The later provider-exhaustion result did not supersede these findings. The
successful 35-job native matrix for that head remains valid historical evidence;
it did not exercise these precise fault-injection windows.

The bounded correction stays in the existing local-mode adapter and its custody
suite, with this plan recording the review disposition:

| Finding | Correction | Regression boundary |
| --- | --- | --- |
| A retained marker can be replaced while directory observations are awaited, then admitted as a new predecessor | Carry the retained marker and parent observations through preparation and the final publication checks; only a fresh operation admits a new persisted predecessor | Substitute a byte-identical marker during the intervening parent observation; refuse publication and preserve both entries |
| An in-place edit after publication can become the newly retained baseline | Read the observed published marker with the existing bounded reader and compare its bytes with the intended publication before retaining it | Modify the destination immediately after the filesystem publication; refuse the write and subsequent removal, preserving the altered evidence |
| Duplicate acquisition can lose the custody violation when releasing the extra lease also fails | Reuse local operation settlement to preserve the custody violation first and the exact release failure second, releasing the extra lease once | Keep the first owner active, fail the duplicate lease release, and check ordered failures, retained barrier, release count and unchanged first-owner custody |

Two independent critics approved this plan. Both required retaining the original
parent observations as well as the marker; a fresh parent snapshot must not
replace already-held authority. Existing on-disk DETACHING admission, semantic
v1 parsing, and custody after a successful publication followed by sync failure
must continue to work. The adapter will reuse the existing application settlement
helper rather than introducing another error aggregation policy.

Independent implementation review identified one integration declaration needed
by that reuse: enroll the already-owned `settle-local-operation.ts` as an exact
entrypoint of `foundation.local-mode.application`. The adapter already has the
inward dependency on that owner. This adds no allowed owner, wildcard import,
public package export, new module or dependency exception.

No new public API, filesystem port, schema, package dependency, production module,
archive-census successor, feature flag or test-inventory change is needed. The
correction does not claim atomic filesystem compare-and-swap. It rejects the
observable substitutions in the existing operation and retains unproven evidence.

Verification proceeds from deterministic RED cases on the unchanged production
baseline to the corrected custody suite and the retained local-mode/settlement
regressions. Run explicit-file cleanup, strict typechecking and the required
changed/fast/workflow checks, recording any executor limitation accurately.
After independent implementation review, push the correction immediately and
request the complete native matrix on the new exact head/base. Refresh the
scoped real-consumer lifecycle evidence for that candidate before final delivery.
Keep this same PR open as a draft.

The unchanged production baseline failed all four new regression cases while
its fourteen existing custody cases passed. After the correction, the combined
custody, settlement, recovery and local-mode batch passed all 89 cases with no
failures or skips. These are mutable-working-tree results; committed-head native
and real-consumer evidence belongs in the PR's final qualification record.

## Ready-for-review follow-up: atomic fixture absence and repair

The owner subsequently requested Ready for review and merge after successful E2E
and independent reviews. This replaces the earlier draft-only delivery boundary;
package publication and unrelated refactoring remain outside this change.

The Ready-triggered CodeQL scan reported alert 149 at the orphan-backup fixture's
exclusive marker repair. Two independent critics confirmed that the existing
`writeFile(..., { flag: "wx" })` already refuses a competing destination. The
preceding `lstat` assertion was an independent absence observation, not authority
for overwriting the path. No production vulnerability was established.

Both critics separately approved consolidating that absence assertion and repair
into `assert.doesNotReject(writeFile(..., { flag: "wx" }), ...)`. Successful
exclusive creation proves absence when restoration begins; any existing regular
file or symlink makes the assertion fail without overwriting it. This preserves
the owned, sequential fixture's contract. It does not claim continuous absence,
general ABA detection, or a stronger write primitive than the existing `wx`.

Keep the rejected public detach, installed-link identity, complete backup
evidence, subsequent successful public detach and second orphan-recovery case.
The change stays directly in the fixture without a helper, fallback write,
suppression, scan exclusion, public API change or test-inventory change.

Validate the exact assertion in a disposable boundary probe: an absent marker is
restored byte-for-byte; distinct and byte-identical existing files reject and
retain their bytes; a dangling symlink rejects and retains its link and absent
target. This supports the primitive's contract and remains separate from public
packed lifecycle evidence. Run the existing strict and cleanup routes, obtain
new exact-head native and CodeQL results, refresh the scoped actual-consumer
proof, and finish independent review before the protected squash merge.

