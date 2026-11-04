# Quality inputs and transaction admission refactor

Date: 2026-11-04. Status: approved for implementation after two independent
plan-review rounds. Base: `1fb16560e6972909e68fb36b9b005bf16273cbea`.

## Objective and admission

The owner requests a substantial end-to-end refactor of growing technical debt,
with universal library usability, clear boundaries, strict typing, critical
regressions and repeated independent review. The suggested 10–15k changed lines
is an orientation, not a quota. No generated churn, unrelated renaming, test
duplication or extra abstraction will be added to meet it.

Three independent researchers inspected capability boundaries, private execution
and public package contracts. They read the live organization quality standard,
repository rules, accepted decisions and actual callers. The previous PR #463
is complete and is not part of this work. PRs #458, #462 and the release-owned
PR #464 remain outside this delivery.

Two demonstrated defects and one recorded architecture exception admit this
scope:

1. **Quality configuration changes can produce a false pass.** The static
   reader validates protected `lint.json`, then execution independently rereads
   the profile and selects `weakened.json`. With the actual installed Stack
   tools, Node 26.11.1, TypeScript 7.0.2 and Oxlint, the same four selected files
   fail `typescript(no-floating-promises)` under the stable profile and pass
   under the changed profile. A public built CLI reproduction used an actual
   atomic filesystem replacement after the first profile read, without replacing
   production modules or the executor. Correct source passes; a stable weakened
   config is rejected as a protected-setting violation. Packed-installed
   qualification is still required.
2. **Core quality coverage requires FMS.** The accepted exception in
   `docs/architecture/executable-capabilities.md` is executable: an ordinary
   neutral topology fails `QUALITY_PROFILE_INVALID`. FMS parsing belongs to the
   opt-in standard package. A single successor can remove both this dependency
   and the four parallel current profile parsing branches.
3. **Mutable transaction Plans can misbind receipts.** Calling the built public
   `applyKnownFileTransaction` with a mutable, JSON-roundtripped valid Plan and
   immediately changing its operation path can return `already-satisfied` for
   another file with the original Plan digest; the intended file stays absent.
   Related admission invokes caller-owned `map`/accessors and checks some budgets
   after copying/encoding. These are public input-boundary defects, not a reason
   to rewrite the recovery protocol.

Quality v4 reports also incorrectly identify schema version 1. Fixing this is
part of the same observed-input contract. Unrelated report producers are not
included merely because they have similar code.

## Alternatives and scope decision

| Alternative                                                                               |                            Expected substantive changed lines | Decision                                                                                         |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------: | ------------------------------------------------------------------------------------------------ |
| Only cache the quality profile and fix report version                                     |                                                      1.5–3.5k | Insufficient: tool rereads, stale topology and the core FMS exception remain.                    |
| Neutral v5, one observed input, bounded verification, FMS projection and actual consumers | 6–10k, with a 10–14k upper envelope if qualification needs it | Main workstream. Removes demonstrated false pass and architecture-specific core policy together. |
| Owned transaction Plan admission and pre-await snapshot                                   |                                                      1.1–1.9k | Separate small workstream and commit; closes the demonstrated receipt defect.                    |
| General private process supervisor rewrite                                                |                                                  5–8k or more | Excluded. Live terminal streams, bootstrap and native custody need a separate design.            |
| Generic receipt, observation, plugin or transaction framework                             |                                                     Unbounded | Excluded; existing owners and narrow ports suffice.                                              |

Estimates count meaningful additions/deletions, not entire `.mjs`→`.ts`
rename pairs. The two admitted workstreams are independently reviewable. They
share no new framework and neither is a prerequisite for the other's policy.
The final report will give actual diff size and remaining bounded debt.

## Workstream A: architecture-neutral quality coverage

### Current contract and migration

- Introduce `quality-source-coverage/v5`. The new runtime accepts v5 only.
  Rejected v1–v4 profiles receive an actionable migration error. All exported
  historical schema bytes stay unchanged; retaining their artifacts does not
  mean the new major executes their profiles.
- Replace `featureProfilePath` with `topologyPath`. Keep the single
  `toolchainConfigPath` compiler-project authority introduced in v4. Remove
  legacy direct `compilerProjects` profile parsing, not compiler configuration
  itself.
- Preserve source/suppression policy paths, protected lint configuration,
  bridge admissions, native gate wiring, governed assets and required scripts.
  Do not change source-language admission or expand native execution authority.
- Add one positive, bounded invocation `budgetMs` to v5, following the existing
  format-coverage convention. The initial repository estimate was 120000 ms;
  measured complete qualification below establishes 300000 ms for adoption. The
  schema allows 1000–1800000 ms; a remaining budget is shared by observation,
  verification and tool stages, never reset per subprocess.
- Preserve the requested schema version in all reports after its header is
  admitted as a positive safe integer, including failures. Unsupported-version
  reports identify that version and the migration problem. Malformed headers
  use the current supported reporting version and an invalid-header problem;
  strings, negative values and unsafe numbers never enter the numeric report field.

### Neutral topology

The versioned data-only topology contains only these consumer-owned technical
facts: `schemaVersion: 1`, `censusRoots`, `packageRoots`, `sourceRoots`,
`testRoots`, `excludedRoots`, `toolingFiles`, and optional `derivedFrom` entries
of `{path, sha256}`. All arrays and paths have explicit bounds, uniqueness and
canonical repository-relative validation. `packageRoots` may explicitly include
`.` for a root package. `toolingFiles` remains exact files, never glob exemptions.

The broad physical census remains rooted at `.` and reopens declared production
and runtime source roots. `censusRoots` describes containers in which undeclared
production sources/packages must be diagnosed; it cannot narrow that physical
census. Test and exclusion precedence, native files, governed assets, package
admission and independent source ownership retain their existing semantics.
Root `.` contains all descendants; a root package must be explicitly admitted
in `packageRoots`, not silently skipped. Workspace inventory independently
detects missing package admissions even outside declared census containers.

`derivedFrom` is optional for hand-authored external topology. Core only checks
contained source-file bytes against SHA-256; it never interprets the source's
architecture or runs a generator. This small data binding makes a generated
projection reject staleness even through the standalone public CLI.

### FMS ownership and dogfood

- Move the existing flat/nested FMS projection semantics to a pure public
  `./quality-topology` export in `@agent-teams/feature-module-standard`.
  `projectQualitySourceTopology(profile: unknown, sourcePolicyPath: string)`
  returns neutral wire data. The root and mapper have no package or Node imports,
  including type-only imports; no core→FMS import is introduced.
- Qualify the mapper's output against the Foundation topology schema and retain
  flat/nested parity cases. Do not create a shared model package for one DTO or
  give the mapper filesystem/process authority.
- A repository-owned strict `.ts` generator calls that mapper, adds the exact
  source-byte binding and writes
  `architecture/foundation/quality-source-topology.json`. Its `--check` mode
  runs on an existing required repository route. It is a projection, not a new
  policy authority. It takes the expected source-policy path from the v5 quality
  profile, preserving the flat FMS source-policy linkage check. The generated
  document binds both its FMS input bytes and this v5 input so changing that
  linkage also makes the projection stale. Freshness does not certify that a
  generator or its classification policy is correct.
- Migrate this repository's real dogfood to v5 and the generated topology.
  Existing Agent Runtime v2 adoption remains on its currently pinned old
  Foundation version; do not edit that external repository or claim its upgrade.
- Qualify FMS `./node` against the candidate Foundation and widen its optional
  peer range to the new major only with that evidence. No unrelated dependency
  upgrades, native pin changes or standard-pin refreshes.

The projection preserves these existing distinctions (deduplicate and sort
paths deterministically; adoption status supplies no exemption):

| Neutral fact    | Flat FMS input                                 | Nested FMS input                                                                                        |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `censusRoots`   | `productionRoots` plus `applicationRoots`      | `scope.workspaceContainers` plus `adoption.applicationRoots`                                            |
| `packageRoots`  | `.` plus `modules[].root`                      | `.` plus `scope.productionModules[].moduleRoot`                                                         |
| `sourceRoots`   | `modules[].sourceRoot` plus `applicationRoots` | Production module source roots plus exact `scope.productionRoots` below each adopted application root   |
| `testRoots`     | All module `testRoots`                         | `adoption.abstractLayout.modules[].testRoot`, each linked to the existing production module/source root |
| `excludedRoots` | `excludedRoots`                                | `adoption.excludedRoots`                                                                                |
| `toolingFiles`  | Exact `generatedRoots[].generator` values      | Empty, as in the current nested mapping                                                                 |

Flat `topology.sourcePolicy` must equal the supplied expected identity. Both
forms require supported FMS v1/v1.1 identity, and nested applications/layouts
retain the current matching checks. Runtime-owned source outside these roots,
nested test precedence, native/assets and generated-directory reopening remain
independent Foundation classification responsibilities.
The mapper makes the old root-package exemption an explicit `.` admission;
the neutral core no longer grants that exemption implicitly.

### One invocation and its consistency guarantee

Application policy receives one immutable normalized observation, including the
accepted profile/version, neutral topology, source authority, selected compiler
projects, package dependencies and classification evidence. Tool preparation
receives those facts, not a config path that lets it independently choose a new
profile. Static validation retains no process execution port.

The guarantee is **coherence of consumer-owned inputs**. An invocation-local,
feature-owned witness binds the actual bytes decoded by existing policy,
configuration and inventory owners. Never hash one read and parse another.
Expose the existing YAML loader factory through `configuration-input/node.ts`;
add optional reader dependencies to `workspace-inventory/module.ts` while
retaining all existing defaults. Do not duplicate their parsers or deep-import
another owner's adapters.

Use the existing full-input census (`generatedDirectories: "observe"`) for the
witness. It covers regular consumer files outside `.git` and `node_modules`,
including local compiler `extends`/references, autodiscovered configurations,
source, data and generated output. Classification still uses its existing
ordinary census and reopening rules; observing generated bytes does not turn
them into production sources. Explicitly consumed inputs outside that census
and the installed protected lint config/extends closure are additional observed
files. The same fingerprint is used whenever an input is read again.

The installed dependency tree is a stable prerequisite. Package-based TypeScript
`extends`, installed type declarations, arbitrary dependency graph inputs and
installed executable bytes are outside this coherence guarantee. Such ordinary
package-based configurations remain usable. Existing tool identity/version
admission remains required, but does not attest dependency-tree immutability.
No TypeScript resolver, new native compiler API process or full dependency
attestation is introduced to widen this promise.

Command stages are capture, pre-execution verification and final verification:
at most three full snapshots, never a new scan per process batch. Static-only
checks use capture and final verification with no process port. Verification
re-enumerates membership and compares fingerprints, including separately
observed inputs. Logical installed lint-preset bindings are re-resolved and
their targets/closure compared; retaining only the old canonical path is not
sufficient. Reapply contained regular-file and symlink restrictions.

Persistent byte modifications, additions, removals and prohibited symlinks
reject. Identical-byte regular-file replacement is allowed: inode identity is
not this contract. The witness is not atomic or ABA-proof against a hostile
same-user writer. Oxlint/TypeScript still reread filesystem inputs; detected
persistent drift invalidates the result. Unrelated document/asset/generated-file
edits can conservatively invalidate a concurrent run and require retry.
Only final stable success qualifies. Drift/budget problems are input/execution
failures, never lint findings or successful defect-detection evidence.

Fixed feature-owned limits (not another consumer settings platform):

| Bound                                                         |                                                       Value |
| ------------------------------------------------------------- | ----------------------------------------------------------: |
| Discovery directory entries / manifests / sources             |                             Existing 500000 / 5000 / 100000 |
| Unique witness files                                          |                   100000, enforced during census collection |
| Unique captured bytes                                         |                                                     512 MiB |
| Generic census data-file read                                 | 16 MiB; stricter owner-specific config/source limits remain |
| Cumulative explicit reads, including repeats and verification |                                                       2 GiB |
| Concurrent bounded file reads                                 |                                                   At most 8 |

All initial decoding, census, tool-admission and repeated verification reads
charge the same cumulative counter. Installed executable admission retains its
existing per-file bounds and charges read bytes, but does not add executable
fingerprints. Keep fingerprints and necessary normalized facts, not a cache of
every file's contents. The existing census factory may accept a narrow optional
all-file cap, preserving defaults for other consumers and checking before adding
members; existing directory/source/manifest caps remain intact.

Start one monotonic clock before the first profile read. Admit the header under
existing bounded input rules, derive its deadline from that original start and
pass remaining time to each actual child. Check cancellation/deadline between
reads, scans and batches; exhaustion starts no more children. Filesystem and
synchronous parsing deadlines are cooperative. Existing bounded process cleanup
grace remains permitted after timeout. No hard real-time cutoff is claimed.
Dogfood hashing/verification duration, not merely stat timing, must qualify the
300000 ms adopted budget. Research measured full-input census at 7865 files /
36282624 bytes / maximum 844774 bytes. This is a checkpoint headroom measurement,
not execution-time qualification.

No global cache, public observation registry, dependency container or framework.
The unrelated format workflow is not rewritten.

### Production and test inventory

Production changes are limited to the quality coverage profile/model/policy,
configuration and observation/execution adapters, tool-session budget plumbing,
their local entrypoints/schemas/composition, the two owner injection seams,
the narrow census cap and the FMS projection owner. `createOxlintSession` also
serves `capabilities/findings-baseline/module.ts`: quality supplies an optional
remaining-budget policy; the baseline caller keeps its current default and
behavior. No second Oxlint implementation is added. Existing protected settings, tool
admission, compiler identity, process custody, source census and explicit-unknown
policy remain authoritative.

Substantially rewritten affected tests/harnesses become ordinary strict `.ts`.
Preserve every old case or record its precise successor. Expected affected
corpus: quality policy/source observations/source targets/census/discovery/
fixture/toolchain profile/governed assets/public CLI, repository lint scope,
packed quality layout and quality pack/registry integration. Do not rewrite
unaffected preset, explicit scanner or tool-resolution tests for line count.
Update strict projects, source ownership, test shard and Windows inventories
atomically; no disappearing or silently skipped test.

## Workstream B: owned transaction Plan admission

- Preserve public Plan signatures, wire schema, digest domains and existing
  errors for valid inputs. Introduce only owner-private admission helpers.
- Inspect own data descriptors before reading values. Reject executable
  accessors, symbol keys, sparse/custom-prototype arrays and functions. Wire
  Plans remain closed. Compiler-input records retain currently accepted inert
  extra fields and explicit `mode: undefined`; normalize only known fields.
  Accept plain/null-prototype records and supported byte views with owned native
  copies. Do not invoke caller `map`, iterators, coercions or getters. Proxies and
  modified global intrinsics are not a new supported adversary model.
- Preflight the existing 32-operation and 16-preimage counts, 8 MiB image and
  16 MiB aggregate raw-byte budgets before image copying, decoding, encoding or
  hashing. For wire Plans, calculate actual decoded length from validated
  base64 geometry and compare with `size` before allocating. The existing
  32 MiB journal encoding/decoding limit stays at its envelope owner boundary;
  it is not a new approximate compiler-input limit.
- Synchronously validate and create an owned deeply frozen Plan before the first
  `await` of apply. Use only that Plan in admission, journal, execution, early
  already-satisfied outcome and receipt construction.
- Do not redesign journal states, leases, commit/rollback, exact-build recovery,
  retained historical journals (including the documented exact Foundation
  0.21.0 known-file route), owner/kernel build bindings, on-disk schemas or the
  supported Windows boundary.
- Public receipt-validation API extraction is excluded: it is useful optional
  DRY work, but not needed to fix the demonstrated Plan defects.

Tests cover the complete admitted input contract as a compact table, real
mutable-Plan receipt binding, limits before work and existing normal/replay/
recovery behavior. Reuse existing installed package and filesystem harnesses;
do not add another installer or supervisor. If a test is substantially rewritten
it becomes strict `.ts` with the same required inventory membership.
Positive compatibility includes zero operations, empty bytes, Buffer, Uint8Array
subviews with nonzero offset, plain/null-prototype records and omitted/default/
explicit undefined mode. The installed candidate regression must create the
originally planned file with its planned bytes and receipt path/digest despite
immediate caller mutation, leaving the distracting existing file unchanged.
Run that regression and inert-input rejection through the exact installed
candidate public root in an owned disposable consumer, with no source/deep
imports or workspace-link fallback. Windows retains pure admission checks and
the existing fail-before-effects unsupported-apply contract.

## Compatibility, release and documentation

Foundation needs a major Changeset for stopping execution of v1–v4. FMS receives
the appropriate current 0.x minor for the added mapper and qualified peer range;
The original input-boundary fix alone required a Repository Mutation patch.
Implementation review also required the bounded optional observer accounting
argument: that public signature change raises the release intent to a minor,
with its exact comparator fingerprint approved in ADR-0074. Source package
versions and released baselines are not edited manually.

Add a scoped accepted ADR, explicitly superseding the quality-runtime portion
of ADR-0067 and closing the ADR-0062 core exception without changing historical
records. After implementation, bind any required artifact breaking fingerprint
to that ADR and use normal decision-baseline promotion. The release workflow
continues to own version/API baseline promotion. Do not repurpose the closed
native-compiler migration. Exported v1–v4 schemas remain byte-identical.

Update current reference, architecture ownership/neutrality, FMS documentation,
schema inventory and a practical v4→v5 migration guide. Explain the old-major
choice for users who cannot migrate yet; do not keep unbounded runtime shims.
Document neutral root-package and monorepo examples plus generated-topology
freshness. Plans, code and reviewer decisions are committed to the repository.

## Qualification and acceptance

| Boundary                  | Required evidence                                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quality policy            | Existing census, exclusions, native/assets, bridges, settings and route cases retained; actual schema provenance; no-process static path.                                                                               |
| Consistency               | Protected A→weakened B regression; changed source/config/topology/project, addition/removal and stale projection reject; stable protected/correct counterpart passes; cancellation and shared-budget exhaustion reject. |
| Universal consumer        | Installed candidate CLI in a disposable non-FMS root package and monorepo; honest floating-Promise failure and corrected-source success with real Stack/TS/Oxlint.                                                      |
| FMS consumer              | Flat/nested mapping parity, schema conformance, installed public mapper and existing `./node` qualification; repository dogfood v5 and required projection freshness.                                                   |
| Transaction public input  | Descriptor rejection without callback invocation, early count/byte budget rejection and actual apply mutation race; Plan/receipt relation retains original operation.                                                   |
| Transaction compatibility | Existing create/replace/replay/no-pending/crash/recovery and supported Windows results through current inventories.                                                                                                     |
| Repository                | Build, focused strict projects and meaningful tests; `check:changed`, `check:fast`, workflow security, required full-ci 35-job native matrix on exact final head/base; adopted coverage unchanged.                      |

Source-built probes establish the defects but do not substitute for installed
candidate E2E. External npm/network failures are diagnosed/retried under existing
gates, never hidden by removing required jobs. A local environment limitation
does not certify a check; use the unchanged native CI evidence for the uncovered
boundary. Pending CI is not a reason to run a redundant full local matrix.

The installed quality drift regression uses a test-owned Node `--import`
preloader that forwards native spawn unchanged and atomically replaces the
admitted lint configuration immediately before the first exact real Oxlint
launch. Candidate Foundation CLI, pinned tool binaries and results remain real.
Its one-shot trigger is recorded outside the consumer tree; assert exactly one
trigger and real tool execution. Require input/execution failure, never a pass.
Pass the preloader only as a CLI Node argument, not inherited `NODE_OPTIONS`.
This is explicitly POSIX fault injection; the Windows managed Host boundary
retains native qualification plus portable read-drift regressions. Stable
protected/faulty, protected/corrected and weakened/faulty counterparts use the
same installed consumer. No production test switch or second installer.

Deadline tests prove that observation/earlier-stage delays reduce later child
`timeoutMs`, subsequent batches never receive a reset deadline, and exhaustion
starts no additional child. Retain real installed timeout/cancellation evidence
through the existing process owner and native inventory.

Plan review: at least two independent rounds by architecture/universality,
execution/qualification and public-contract critics before production edits.
Implementation review: those roles cross-review current code, with further rounds
until every actionable issue is fixed or explicitly rejected with evidence.
Final reviewers bind verdicts to the final source SHA; author self-review is not
independent approval. Record role, SHA and verdict in the PR.

## Delivery sequence and rollback

1. Freeze this plan after two critique rounds; publish the plan commit immediately
   to a short branch. Run required available checks before opening the draft PR.
2. Implement quality core, FMS/consumer qualification and transaction admission in
   disjoint ownership lanes; integrate source/test/gate inventories and docs.
3. Commit coherent reviewed slices and immediately push each commit. No local
   unpublished commit queue. Keep a record of scope/plan corrections.
4. Resolve strict typing, lint, architecture and focused E2E; obtain repeated
   independent reviews. Bind compatibility approval to actual observations.
5. Push the final reviewed head, request full CI, inspect every native/aggregate
   result and current base, resolve any concrete failures without weakening gates.
6. Merge only with current independent review and complete exact-head/base
   evidence; verify main and its post-merge checks. Publication remains the
   existing separate release-owned operation.

Rollback is an ordinary source revert coordinated with the major release
boundary. Before publication old consumers remain on their pinned old package.
Do not roll back a committed transaction by inventing a new journal interpreter.

## Explicitly deferred findings

- Private launcher SIGTERM can leave a synthetic descendant alive when only the
  outer launcher PID is signalled. Live stream/stdin behavior, pre-install
  bootstrap and POSIX/Windows custody require a separate bounded design. Do not
  mechanically replace launchers with a capturing executor.
- `pack-test-support.mjs` has an immediate-abort listener race across an awaited
  spawner acquisition. The caller contract merits a narrow follow-up; no current
  production packaging caller supplies this signal. It does not justify a
  packaging-framework rewrite in this PR.
- Unrelated large SDK comparison code, supported migration drivers, historical
  schemas and exact-build recovery handlers are not dead code by size or age.

These exclusions prevent claiming that all repository technical debt has
disappeared. Acceptance means the admitted defects and the named core legacy
branches are closed, with the full supported behavior qualified.

## Review and execution record

- Research completed on the base above; public built probes reproduced the two
  defects. Base build and `check:fast` passed with exact admitted local tools.
- Plan round 1: three independent critics accepted the scope but requested
  changes before implementation. Resolved by limiting the coherence claim to
  consumer-owned bytes plus installed lint closure, allowing identical-byte
  inode replacement, specifying limits/deadline/stages/owner seams, retaining
  the findings-baseline caller, documenting exact FMS/root/source-policy mapping,
  preserving inert compiler-input extras and the journal budget boundary, and
  requiring deterministic installed regressions for both workstreams.
- Plan round 2: all three independent roles approved the complete substantive
  plan, SHA-256
  `62ee131a2281564aa16f44a5c6e7fcfaa556abcd1827cda54e44d2a30b82b96a`,
  before production edits: architecture/universality, execution/E2E and public
  contracts/compatibility. No blockers remained. The execution critic's final
  nonblocking correction removed an incomparable older census measurement from
  the headroom paragraph. This status/record update adds no implementation scope.
- Implementation round 1: independent architecture/input-coherence,
  public-contract/consumer and scope/E2E reviewers identified three bounded
  corrections. Node's cached package resolution did not prove fresh lint target
  bindings; a narrow data-only JSON resolver now observes fresh manifests,
  aliases and relevant absences, with unsupported export forms documented.
  Retired-temporary duplicate reads bypassed quality's cumulative budget; the
  existing owner now accepts optional accounting/deadline callbacks and keeps
  all physical-custody checks. Source CLI fixtures trusted an unchecked report
  cast; source and installed fixtures now share a narrow validated report reader.
- Incremental round 2: the public-contract/consumer reviewer independently
  reproduced the corrected report rejection and real hardlink/accounting cases.
  An intermediate metadata-checkpoint gap was fixed. Stable actual byte reads,
  conservative charges on unsuccessful reads and original identity comparisons
  remain. These are worktree findings, not final-head qualification.
- Integration has preserved the migrated test identities, strict inventories and
  whole-report determinism. Real built CLI/source scenarios pass. Installed
  candidate E2E, final-head review, complete native CI and merge remain pending.
- Required changed-file typed lint also exposed the retained oversized packed
  Docs consumer functions and package-manifest test callbacks in two touched
  `.mjs` entrypoints. Their existing scenarios move into cohesive private strict
  `.ts` helpers, keeping the entrypoints, phase/test order, installed tools,
  artifact custody and assertions. This closes affected E2E maintenance debt;
  it does not admit the deferred process-lifetime rewrite or another installer.
- The repeated core review approved the corrected production worktree after
  independently passing all 16 resolver/witness cases. Integration passed the
  architecture check, 38 source/governed-asset cases after DI cleanup, strict
  compilation, peer inventory and ordinary API compatibility. ADR-0074 was
  added through the normal accepted-decision promotion; all 70 prior accepted
  decision entries and released API/schema bytes remain unchanged.
- The manifest extraction retained all 39 tests/subtests and passed its existing
  suite plus strict typing/lint. An independent execution of the repository's
  mandatory runner completed all three adopted quality identities after the
  test-helper moves; helper source locations did not replace selected-entry
  authority. Final source/head qualification still requires current PR review
  and full-CI evidence; these focused results do not replace it.
- Full repository dogfood exposed stale positions for seven retained canonical
  JSON bridges after the Plan refactor. Only their exact positions/digests were
  refreshed: six expressions are byte-identical, and the seventh now uses the
  closed, owned `admitted` wire value. Independent Mutation review confirmed no
  expansion of admission count, scope, rationales or rejecting-test ownership.
- The initial 120000 ms whole-invocation estimate exhausted at 121118 ms. The
  previous runtime applied 120000 ms to each child, so reusing that number for
  all observation, verification and batches was not equivalent. A complete
  measured run passed in 133780 ms with a 300000 ms repository budget: 16
  selection batches, six compiler projects and 16 typed-lint batches all exited
  successfully, followed by final input verification. A strict, test-owned
  timing preloader forwarded native spawn arguments/results unchanged and wrote
  observations outside the consumer. Two independent reviewers approved this
  measured root-only correction. Per-child `min(120000, remaining)`, Windows
  batching, source scope, three snapshots and all resource limits are unchanged.
  The measurement supplies adoption headroom, not a cross-platform performance
  guarantee; native qualification remains required.

### Reconciliation with the concurrently merged Stack cleanup change

The reviewed head `34cc50a2e341e597accf104042739000b9725b43` completed all 35
effective jobs in full CI run `41883509672`, attempt 2, against
`1fb16560e6972909e68fb36b9b005bf16273cbea`. Independent Windows, Linux installed
and Darwin audits confirmed the mandatory identities, real input-drift rejection,
public Mutation consumer, process conformance and artifact custody.

The final merge preflight then found actual `main` at
`b66641cad3e4ff2042872a8a1b66214cc775d5d2` after PR #462 merged. The PR API still
reported the older base. The completed run therefore qualifies only its recorded
tuple; the independent main-branch read remains required before final merge.

Three independent roles reviewed this bounded reconciliation plan before edits:
quality architecture/execution, scope/E2E preservation, and Mutation/public
contracts/owner identity. All approved the following scope:

1. Merge the new main commit into the reviewed head, preserving both parents and
   all 20 mainline file changes. The four shared files have disjoint additions:
   `AGENTS.md`, FMS ownership, public data exports and source dependency roots.
2. Regenerate quality topology through its existing owner generator. Only the
   FMS provenance hash should change; projected source/test roots and the v5
   profile remain identical. Preserve the new opt-in cleanup API, presets,
   tests, installed consumer probe and release intent from main.
3. Keep ADR-0074, historical baselines, the 49-schema catalog, the Foundation
   2935-member bound, complete test inventories and mandatory identities intact.
   Ordinary quality routes retain their read-only behavior. Main's cleanup
   fixture remains separate from the root/flat/nested quality consumers.
4. Validate the combined build, strict/architecture/API gates, topology freshness
   and the existing affected Stack and quality tests. Apply the new cleanup
   instruction only to explicitly selected task-owned JS/TS edits. The initial
   merge required only generated JSON and this execution record; the subsequent
   semantic review below admits a bounded correction in the existing resolver.
5. Independently review the actual combined tree, create an owner-authored
   two-parent commit through the GitHub integration and immediately advance the
   feature branch with the expected old head. Main retains its ordinary squash
   merge policy. Re-read the complete PR source-commit list after its base updates.
6. Obtain a fresh complete native matrix on the new head/current main tuple.
   Revalidate actual main, PR refs, source identity, reviews and all aggregate
   results before merging, then verify the resulting main commit and its CI.

This reconciliation admits no additional refactoring or public contract change.

#### Combined-input semantic review

The initial merge-only tree `cc5c1c2965299bd55be55ddda8fc30e2a2022954` preserved
both parents and passed 48 focused checks plus `check:fast`. Scope and public
contract reviewers confirmed that preservation. The quality critic nevertheless
found a concrete mismatch with the native inheritance semantics established by
main's Stack tests: a symlinked JSON file inherits beside its requested filename,
and a directory symlink followed by `..` needs native filesystem resolution.
Foundation instead traversed from the physical target and normalized `..` early,
which could inspect a different installed sibling policy from the real tool.
Preservation and green existing tests therefore did not close this integration.

All three independent roles approved this narrower correction before its edits:

- Keep the physical file for the existing strict reader, fingerprints and trusted
  installed-preset exemption. Keep a separate native requested context for
  inheritance, cycle detection, the 32-context bound and unique observation IDs.
- Resolve the raw requested parent before appending the requested basename. Bind
  both that parent and the requested file through the existing alias witness.
  Pass only canonical physical paths to the strict reader; its normalization and
  the witness's physical-byte accounting remain unchanged.
- Limit production changes to the existing private resolver and protected-config
  traversal. Preserve root admission, exact export support, absence observations,
  cancellation/deadlines and all resource limits. No new public API, resolver
  framework, dependency or witness interface is admitted.
- Add focused controls in existing test entrypoints: file-alias inheritance with
  opposing sibling policies and a valid counterpart; native directory-link/`..`
  traversal; and parent retargeting that preserves the final physical file.
  Include repeated physical bytes under different requested contexts to protect
  closure accounting and observation-ID uniqueness. Retain existing regressions.
- Review the actual correction independently, record its final diff size, and
  qualify the new head/base. The line-count estimate does not justify deleting
  these controls or admitting unrelated edge cases.
