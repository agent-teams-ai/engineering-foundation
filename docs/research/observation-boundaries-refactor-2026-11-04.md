# Observation boundaries: debt audit and implementation plan

Status: implementation integrated. The initial plan preceded implementation;
observed results and review corrections are recorded below. Final-head review,
native CI and merge evidence are tracked in
[PR #463](https://github.com/agent-teams-ai/engineering-foundation/pull/463).

Audited base: `99b7dac2fd3c3b2b1b024a8a640f6e13ec79dbef`, tree
`4510029435f1c4c184ad45650402312025e7cefb`. The local checkout tree was compared
with the live GitHub main reference before research. Three independent reviewers
examined Foundation capabilities, portable/managed documentation, and repository
execution tooling. The current organization Engineering Quality Standard was
read live; accepted repository decisions and immutable artifacts remain binding.

## Goal and scope

Repair the places where an observation claims more than the code actually
establishes: bounded input reads, source-file identity, fresh workspace membership,
complete source projection, and compiler admission before execution. Remove the
duplicated mechanism or misplaced lifetime decision that caused each defect.

The owner permits a substantial refactor, including a 15–25k-line change when
justified. Changed-line count is not an acceptance criterion. Existing source
already has useful feature boundaries, inward dependencies, exact package
ownership, and extensive regression coverage. This plan does not replace those
boundaries with another framework or rename files to increase the diff.

All changes stay in this repository. The root policy remains architecture-neutral.
The private registry stays static. There is no new package, parser, resolver,
process supervisor, service locator, plugin system, feature flag, storage protocol,
or mandatory consumer adoption.

Open PR [#462](https://github.com/agent-teams-ai/engineering-foundation/pull/462)
owns Stack's opt-in cleanup operation. PR
[#458](https://github.com/agent-teams-ai/engineering-foundation/pull/458) owns
dependency-updater research. Their implementation surfaces are outside this
change. Changesets, publication workflows, package versions, dependency pins,
required checks, coverage thresholds and workflow protections are also outside
scope. A normal changeset describes released behavior changes; it does not run
a release or change the release engine.

## Findings and evidence

Priority denotes impact and propagation risk, not a security severity rating.

| Priority | Finding                                                              | Evidence and consequence                                                                                                                                                                                                                                                                                                                                                       |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1       | Two documentation consumers duplicate an unsafe physical file reader | `node-consumer-repository-files.ts` and `adoption-input.ts` open a FIFO before checking file type and use `FileHandle.readFile()` after only an initial size check. Actual-source reproductions block on a writerless FIFO. With an 8-byte limit and a 4-byte initial file, a deterministic append caused both readers to consume 1,048,580 bytes before rejecting the result. |
| P1       | Source graph can change the identity of a physically observed file   | The generic source reader accepts a POSIX filename containing a literal backslash; graph normalization converts it to a slash. An actual-source reproduction returned graph path `src/a/b.ts` for physical file `src/a\\b.ts`; the graph path did not exist.                                                                                                                   |
| P1       | SDK growth rechecks a cached workspace selection                     | The capability root captured inventory once, closed `readInvocation` over it, and supplied the same inventory through `workspace.read`. The baseline actual Foundation-check route published an incomplete report after a new package appeared under an existing workspace glob. The new regression failed before the fix and now rejects before publication.                  |
| P1       | Repository compiler admission happens after execution on some routes | `dev.mts` build and private catalog entries execute `typescript/bin/tsc` before checking its resolved package metadata. Native qualification executes `tsc --version` and uses substring matching. A stale installation can execute a forbidden compiler before rejection. The current installed compiler is 7.0.2; this finding is about admission order.                     |
| P2       | Source reader cancellation can become a successful final snapshot    | An actual-source reproduction aborts after the last pre-read check and receives the file array. The reader lacks a post-await/final cancellation check. Some downstream callers check again; that does not repair the reader's own contract.                                                                                                                                   |
| P2       | Source copying and its digest share an overbroad exclusion           | `profile-source.ts` excludes entries by basename at every depth, including ordinary files. A legitimate `packages/example/src/coverage/policy.ts` is invisible to both copy and digest. No currently tracked file loss was found; the algorithm permits future silent drift.                                                                                                   |
| P2       | Workspace declaration report loses the selected schema version       | The loader accepts v2, but private settings discard the version and success/failure reports use the v1 constant. Preserve the validated version without changing the public report schema.                                                                                                                                                                                     |
| P2       | Strict tooling membership is manually repeated                       | Ordinary `.ts` membership is spread across root and child config lists. A static census found no current missing maintained file. Simplify this duplication only if exact TS7 file-set comparison proves coverage is preserved; do not present a possible future gap as a current typecheck failure.                                                                           |

The initial runtime reproductions used supported Node 24 type stripping and an
ephemeral source-resolution hook. They did not execute an older TypeScript
compiler/parser and are not strict typecheck, packed-consumer, or native CI
qualification. The repository's exact Node 26.11.1, Bun 1.4.3 and pnpm 11.20.0
were then installed without changing repository pins. The source installation
reports TypeScript 7.0.2 and Oxc 0.142.0. Baseline build, fast checks and workflow
security passed before implementation.

## Existing protections to retain

Repository Mutation already owns the public `readBoundedRegularFile` mechanism.
It bounds actual reads to the limit plus one sentinel byte, uses POSIX nonblocking
no-follow opens, and observes descriptor/path identity and stability. Its outcome
is `read`, `changed`, or `invalid`. It deliberately does not own consumer-root
containment, required/optional semantics, single-link policy, UTF-8 rules,
cancellation, or the lifetime of a descriptor used for a later write.

The source reader already rejects symlinks, case/NFC collisions, NUL content and
oversized source inputs. The v2/v3 topology route has stronger discovery and
snapshot checks. Its selected package universe is different from v1/public
governed roots; sharing mechanics must not silently share those policies.

SDK growth already binds Git head/tree, manifests, build inputs, lock and tool
identity, preserves unavailable subjects, validates report destinations and
rechecks invocation before publication. Preserve these protections and complete
the workspace membership observation behind them. No C0 or wire-contract change
is required.

The Node projection already checks three exact manager/policy projections,
source identity and deterministic source bytes. Stack's executable resolver
already admits package metadata before executing its compiler. Reuse these
ownership patterns; do not add another toolchain product.

## Implementation sequence

### 0. Reproduce and freeze the plan

1. Record base SHA, conflicting open work, applicable decisions and supported
   tooling. Complete independent code research before implementation.
2. Review this plan for missed compatibility, hidden scope expansion and tests
   that would only mirror implementation. Resolve findings in the plan.
3. Push the plan as the first branch commit and open a draft PR. Push every
   subsequent commit immediately. Use the current organization owner identity,
   not an assistant identity.
4. Retain baseline results and actual reproductions. A failing new regression
   must exercise the affected public route or physical mechanism before the fix.

### A. Bounded documentation input reads

Owners: Docs Protocol portable-documentation and Docs Protocol Agent Teams
consumer-integration. The physical read owner remains Repository Mutation.

- Replace the two unsafe open/stat/readFile loops with the existing public
  `@agent-teams/repository-mutation/node` reader. No cross-package deep import.
- Keep containment, ancestor/canonical-path checks, missing-input semantics,
  single-link rejection, managed mode masking and each owner's error mapping
  in its own wrapper. Bind the final named-file observation to the reader's
  returned identity; adoption retains single-link rejection on both the returned
  observation and final named file. Keep strict UTF-8 and BOM/NUL rejection.
- Deliberately map shared invalid/changed outcomes. Preserve observed error
  codes where meaningful; do not accidentally turn symlink rejection into a
  missing optional file or conceal an IO failure. Only initial read admission
  may yield optional absence. Disappearance after successful observation remains
  failure. The coarse invalid outcome maps to the existing owner error family;
  do not read again merely to reconstruct a more specific historical error.
- Remove the replaced loops. Do not introduce optional flags or a generic
  filesystem facade. Do not migrate unrelated healthy readers merely because
  they use similar syscalls.

Required evidence: public portable check/doctor with a FIFO adoption input;
managed public input/check route with a FIFO in a file actually reached by that
route; bounded actual-byte growth rejection; stable bytes/mode; optional absence;
required missing, directory, symlink/ancestor alias and hardlink rejection;
adoption encoding failures. POSIX FIFO evidence is not a Windows pipe claim.
Include wrapper-level disappearance and replacement/final-hardlink races after
a successful physical read; shared-reader tests do not cover that owner seam.
Use existing shared-reader growth/identity qualification plus integration proof
that these owners now call that reader; avoid duplicating every mutation test.

Keep separate: profile readers with per-chunk cancellation, authoring readers
with a different taxonomy, externally selected lockfile identity, archive
descriptors retained for chmod, attempt/install records, journals and independent
qualification oracles. The safe bootstrap reader is not required for this fix.

### B. Source identity and observation lifecycle

Owner: Foundation source-inventory. Public graph and existing capabilities remain
consumers through their existing contracts.

- Validate discovered repository-relative names before lossy normalization,
  traversal or parser/resolver admission. Source-inventory owns this neutral
  physical identity guard. Do not import the v3 policy backwards or impose its
  portable-name and package-selection rules on v1/public graph. Preserve generic
  directory roots, current treatment of `.` and the current extension scope.
- Check cancellation after asynchronous observation and immediately before
  returning success, including empty and final batches.
- Make traversal count unique observed directories/files for overlapping roots.
  Preserve ignored metadata/dependency trees, deterministic order and current
  governed-root scope.
- Do not add directory snapshot retention or a new directory-entry limit in this
  slice. Those require a separately specified resource/compatibility envelope:
  a new finite limit can reject a previously admitted stable tree. This work
  fixes the demonstrated name/cancellation defects and overlapping-root work
  without claiming atomic directory capture or filesystem freezing.
- Keep v2/v3 topology policy and current parser/resolver unchanged. Consolidate
  only mechanics with the same contract; leave genuinely different traversal
  semantics explicit. Two walkers are preferable to policy flags that disguise
  different selection contracts.

Required evidence: public graph and FMS Node consumer reject a physical name
whose normalization changes identity; valid nested and Unicode paths preserve
results; cancellation during final read/empty traversal cannot pass; overlapping
roots return each source once; existing case, symlink, NUL and budget tests remain
green. Preserve independent v1/public and v2/v3 selection parity for nested
`dist`/`coverage`, generated roots, `.git` and `node_modules`.

### C. SDK growth workflow ownership and fresh membership

Owner: public-api-compatibility application workflow; filesystem/Git adapters
observe facts and outer composition selects implementations.

- Move the SDK route's observation lifetime and sequencing out of the capability
  composition body into one feature-owned operation with narrow existing ports.
  Do not create a generic capability runner or a new public session API.
- Bind the initial workspace inventory to the invocation that the check uses,
  including the discovery-to-initial-identity interval. Cover names, roots,
  manifest paths, module type, explicit export status and ordered export
  conditions/fallback arrays, not just a set of package paths. Comparison must
  preserve condition order: the existing canonical JSON serializer sorts object
  keys and is not by itself an order-sensitive inventory comparison. Keep that
  serializer and the C0 contract unchanged.
- A fresh final observation must check membership and the policy-facing facts
  used by execution, or a proven binding to their exact bytes. A callback closing
  over only initial inventory is insufficient. This is bounded reobservation,
  not an atomic Git/filesystem snapshot or a general ABA-prevention protocol.
- Revalidate after discovery and before report publication. Addition, removal,
  rename or unreadability of a selected package aborts execution before the
  writer, preserving any prior report without attributing it to the new
  invocation. Cancellation remains cancellation. Do not publish a new report
  from changed execution inputs, including a newly labelled incomplete report.
- Preserve destination fences, cancellation, normal v1 behavior, scope of
  unrelated untracked files, existing digests and unavailable-subject semantics.
- Separately retain the recognized requested workspace-declarations schema
  version at the loader boundary and report it for v1/v2 success, validation
  errors and downstream failure. Preserve the legacy settings shape.

Required evidence: add a package under an existing workspace glob during the
actual route and prove no report publication; capture initial/final membership
changes, same-membership manifest-fact changes between discovery and initial
identity, and export-condition reordering with identical keys/targets. Cover
cancellation and observation errors; unchanged inputs preserve existing v1/v2
outcomes/report bytes, including intentional incomplete evidence for missing
authority (an unchanged workspace alone does not establish qualification);
existing package/HEAD/lock mutation rejection stays intact. Exercise report
version provenance through the capability route, including valid v2 input whose
workspace observation later fails.

### D. Repository execution and projection boundaries

Owner: existing private repository tools. No change to Stack cleanup, runtime
custody, release engine or workflow protections.

- Admit a resolved TypeScript entrypoint by package identity and exact declared
  pin before every affected private compiler launch, including bootstrap and
  native qualification and the scaffolding qualification launcher. TS7's wrapper
  delegates to a platform native package: resolve and check that package's exact
  manifest and executable from the wrapper's context as well. Do not import the
  candidate's executable resolver to perform admission. Reading metadata must
  not execute candidate code. This is version/selection admission, not archive
  integrity or a hostile-writer TOCTOU guarantee. Reuse a private narrow helper
  and the existing runtime/profile owner.
  The closed launch inventory is `tools/dev.mts`, catalog-driven compiler
  entries in `tools/repository-command.mts`, `tools/qualify-native-tools.mts`,
  and `scripts/pack-scaffolding-qualification-test.mjs`. Existing installed
  consumer compiler/parser owners are not silently included in this refactor.
- Make version observations exact. A string containing a desired version is
  not proof of the expected version. Do not run a real obsolete compiler to test
  refusal: use an inert marker executable with deliberately wrong metadata.
- Separate actual dependency-install directories from exact repository-generated
  roots in profile copying/digests. A nested source directory or ordinary file
  named `coverage`/`.cache` must remain visible. Keep generated package `dist`,
  copied LICENSE, build metadata and the three existing allowed projections
  under their current owners. Preserve the root `.git` exclusion for both a
  checkout directory and a linked-worktree marker file; dependency installation
  boundaries retain their intentional exclusions.
- If TS7's actual file set proves parity, replace repeated ordinary `.ts` include
  lists with bounded maintained-root globs and exact syntax/negative-fixture
  exclusions. Compare each required project's file set and effective compiler
  options, not merely their union; `tools` retains its stricter unchecked-index
  setting. Preserve specialized projects and transitive helper membership.
  Do not add a new generalized inventory/check framework for this cleanup.

Required evidence: marker never executes for missing/wrong/stale compiler
metadata; exact installed compiler proceeds; copy contains nested legitimate
sources and their edits alter the digest; real generated roots remain omitted;
source/target projection freshness still fails on meaningful changes. If config
lists change, compare actual compiler file sets before/after and demonstrate a
new ordinary tooling/test file enters a required strict project.

### E. Integrate, review and qualify

1. Keep implementation lanes disjoint. The coordinator owns shared test
   inventories, architecture profile, tsconfig integration and PR state.
2. Extend existing risk-focused suites where possible. New test files join the
   exact-once Linux/Windows inventories and strict projects in the same commit.
   Do not create unit tests for each extracted helper or duplicate fixed oracles.
3. Run focused regressions, build, changed checks, fast checks, workflow security,
   architectural ownership and public package/API checks relevant to changed
   boundaries. Fix real failures without shrinking scope or weakening checks.
4. Perform at least two independent cross-reviews after implementation. Reviewers
   do not approve their own lane. The first pass checks architecture, correctness
   and regressions; the second checks the integrated final head and prior fixes.
   Repeat for new substantive findings until no blocking findings remain.
5. Request the complete native full-CI matrix bound to the final head/base through
   the existing request protocol. Continue useful review and fixes while CI runs.
   Do not relabel earlier-head results or convert local review into a status.
6. Record exact reviewed SHA, reviewer role and verdict in the PR. Read all
   external review feedback and resolve applicable findings. A provider failure
   or incomplete automated review is not approval.
7. Re-read PR head/base, source commit identities, required checks and independent
   review before an owner squash through the approved GitHub plugin route.
   Verify the final commit attribution, tree and main CI after merge. Do not
   claim native qualification or completion while a required gate is missing.

## Compatibility, rollback and failure semantics

No public schema, C0 wire, retained fixture, accepted ADR, journal, recovery
handler or released baseline is edited. Existing supported operations remain
available. New diagnostics use the owning current envelope. Stricter rejection
is limited to an already-invalid/unstable input or a demonstrably incomplete
observation; ordinary scope and successful output remain compatible.

Each implementation lane is independently reviewable and reversible. Rollback
reverts code and its new fixtures/config membership together, never persisted
evidence or a consumer's data. No rollout, package publication or consumer
upgrade is performed implicitly by this refactor.

## Deferred findings

- Private launcher cancellation through manager/child/grandchild needs a separate
  real lifecycle reproduction. Existing managed process custody must be assessed
  before changing it. Do not introduce a second supervisor from a static smell.
- Generic directory capture/revalidation and an entry-count budget need a
  separate finite resource contract and retained-metadata bound. The selected
  source-reader fixes do not claim an atomic snapshot of mutable directories.
- No current missing maintained strict-file membership was proven. Prefer a
  bounded config simplification with compiler evidence to a speculative gate.
- Do not rewrite stable transaction recovery, source resolver, schema catalog,
  release automation or all legacy JavaScript as part of input observation work.
- Historical architecture scores are historical evidence, not current system
  conformance or a reason for cosmetic refactoring.

## Completion record

### Delivered ownership changes

- Both Docs readers use the existing public bounded reader. Their own containment,
  strict text or byte/mode policy, single-link rule and final named-file identity
  checks remain in the owning adapters. Post-read disappearance cannot become
  optional absence. Coarse invalid physical input is reported as invalid without
  reopening it to reconstruct an older error classification.
- Source inventory validates discovered names before downstream normalization,
  checks cancellation after asynchronous observation and visits overlapping
  directories once. Generic source selection and v3 source policy remain separate.
- The SDK application operation owns initial and final bracketed observations:
  fresh inventory, existing invocation identity, fresh inventory. Its private
  equality key retains ordered resolution facts without changing C0 serialization.
  Changed/unavailable inputs preserve the prior report. Stable insufficient
  evidence still produces the existing incomplete result.
- Workspace report provenance is captured before schema validation once a
  supported header is observed. A proposed additional settings field was removed
  after the retained parity fixtures exposed an unnecessary shape change.
- Private compiler admission checks wrapper and native-package metadata before
  execution in all four launch owners. It uses the actual runtime's issuer search
  paths, rejects unsupported resolver layouts and requires canonical native
  metadata selection. It is not executable-byte attestation or an atomic
  filesystem guarantee.
- Source projection excludes generated material at owned locations and retains
  legitimate nested source names. Native separator conversion preserves literal
  POSIX backslashes, so the digest reads the same physical files that copying uses.

### Independent review corrections

Plan review tightened full ordered SDK facts, final Docs pathname binding,
native TS7 selection and scope exclusions before implementation. Implementation
cross-review independently examined Docs, Foundation and repository tooling.

Tooling review reproduced three selection failures using inert markers and the
actual installed wrapper bytes: source-build resolver branches, a nested wrapper
package scope and a conditional native metadata export. All are now rejected
before candidate execution. A proposed Node-only metadata API failed an actual
Bun 1.4.3 startup check and was replaced with the bounded dual-runtime lookup.
Another reproducer proved that a literal POSIX backslash filename could change
without changing the old digest; the corrected projection observes that mutation
and matches the copied bytes. These findings were fixed and independently rerun.

Required typed lint additionally corrected new test registration and fixture
typing. New suites/helpers have explicit strict-project membership. Existing
legacy test files were not rewritten just to register a separate regression suite.
Four new suites enter the exact-once Linux and Windows inventories; SDK and
workspace regression helpers run through their existing registered wrappers.

### Executed evidence before final native CI

| Boundary                                  | Observed result                                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Baseline repository                       | Build, `check:fast` and workflow security passed before implementation.                                                                                                                                                        |
| Docs regressions against old distribution | 10 failures / 2 passes; actual overread, final pathname races and FIFO hangs reproduced.                                                                                                                                       |
| Corrected Docs                            | Node 26: 15/15 including existing adoption cases; Node 24: 12/12 new cases; final lint-corrected Node 26 repetition: 12/12. No skips in these Linux runs.                                                                      |
| Source reader against old distribution    | Four of five new cases failed: physical identity, final-read cancellation, empty-directory cancellation and repeated traversal.                                                                                                |
| Source and workspace integration          | 149/149 passed, including legacy configuration/diagnostic parity and actual CLI provenance. The final schema-validated provenance helper also passed separately.                                                               |
| SDK execution                             | Full wrapper 17/17 passed; final nine actual-route regressions passed again after fixture typing and registration changes.                                                                                                     |
| Compiler/projection                       | Final owner run 31/31 and independent focused run 30/30 passed with different documented selection filters; no skips. The earlier four existing runtime/profile suites passed 77/77.                                           |
| Actual runtime compatibility              | Node 26 and Bun 1.4.3 native qualification passed independently; actual Bun build passed. The current helper admitted the installed pnpm layout under both runtimes. That layout check is not final-head source qualification. |
| Static checks                             | Changed source/test/tool typed lint, lane syntax lint, required strict TS7 projects and formatter checks passed. Integrated required gates and exact-head CI evidence are recorded in the PR.                                  |

Source commits are published immediately through the authorized GitHub plugin.
The first implementation checkpoint is
[`137506b3`](https://github.com/agent-teams-ai/engineering-foundation/commit/137506b3c5c6a27e3492bd08a43587afe02c42c4).
No local result is substituted for the required final-head/base native matrix,
and no candidate workflow success claims to repair the documented GitHub Free
workflow-source trust limitation.
