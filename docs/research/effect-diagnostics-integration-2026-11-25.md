# Optional Effect diagnostics in Stack Toolchain

Date: 2026-11-25. Status: two plan-review rounds complete; implementation and code review in progress. Owner:
Stack Toolchain. Delivery: one Draft PR, two independent plan-review rounds,
implementation and installed E2E, independent code review, exact-head full CI,
owner squash and post-merge verification. Package publication remains the
separately assigned release workstream.

## Outcome and scope

The owner requested the next shared Effect diagnostic integration, a Markdown
plan reviewed and improved twice, and slightly more useful qualification than
the initial small Linux pilot. The result must be usable before finished
applications exist. Independently wired disposable consumers are the execution
subjects; this delivery does not claim their adoption by production products.

One explicit optional Stack entry checks standalone consumer TypeScript projects
with the qualified native Effect compiler. When called, its selected Effect
policy is mandatory: ordinary TypeScript success cannot substitute for it.
The same built Stack artifact is checked through its installed API and CLI with
the published GM/Effect cohort. A bounded existing 100-module fixture supplies
one additional compiler-cost observation. This extra scope adds evidence, not
a second compiler, generator, runtime or general plugin system.

Excluded: changing ordinary typecheck fallback; making Effect a mandatory
dependency of all Stack users; changing default EF/GM pins; application migration;
runtime Effect dependency in Foundation; browser/Desktop execution claims;
untrusted plugin isolation; distributed recovery; npm publication; a new CI
workflow or admission protocol; production or million-line capacity claims.

## Source and ownership packet

Inspected source coordinates:

- Foundation base `fac03920e50ebde038ae415edeb7aa9e3d610ada`, Stack 0.3.1.
- GM `330c28dbea1a3de812d3aee5ddb71ef829dee347`.
- Research `c99f19835ca3e80c5a7268f8bf42f089418e1cf0` and its
  [completed native diagnostic experiment](https://github.com/agent-teams-ai/engineering-research/tree/c99f19835ca3e80c5a7268f8bf42f089418e1cf0/evidence/experiments/effect-diagnostics-2026-11-24).
- Organization direction `a277e75589ab765272961a5e1eba6725d098bd89`, including
  [Foundation-first](https://github.com/agent-teams-ai/.github/blob/a277e75589ab765272961a5e1eba6725d098bd89/docs/architecture/ecosystem-vision.md)
  and the [quality standard](https://github.com/agent-teams-ai/.github/blob/a277e75589ab765272961a5e1eba6725d098bd89/docs/engineering-quality-standard.md).

[ADR-0064](../decisions/0064-independent-stack-toolchain-package-boundary.md)
owns shared tool execution; [ownership](../architecture/ownership.md) keeps
consumer architecture and policy with consumers. This is an additive optional
technical entry in that existing package, not a new Foundation capability or
an amendment to frozen ADR-0061. The owner's explicit fixture-first direction
governs this qualification; real product activation and its existing gates
remain separate. Update the current Stack guide to name these distinct stages
without rewriting historical accepted decisions.

The current fallback stops at its first successful engine. Its diagnostic
classifier recognizes four/five-digit ordinary error codes, while the inspected
Effect codes have six digits. These are requirements for the new integration,
not findings that the existing supported checker cohort is broken.

## Compared implementation shapes

All options promise the same narrow Linux x64 compiler-policy check; none
promises runtime, browser, all-platform or hostile-input isolation. P means new
handwritten production/integration LOC; T means new tests/fixtures beyond the
retained upstream corpus. Engineer-days assume existing prerequisites and one
experienced engineer with focused review. They are planning bounds, not a
line-count target or delivery promise; generated, vendored, docs, package/native
distribution and broad rollout work are excluded. U is fitness confidence,
N expected reliability within this scope, C maintenance complexity (higher is
worse). These are ordinal judgments, not measured availability.

| Rank / shape | P LOC | T LOC | Engineer-days | U / N / C | Main tradeoff and rejecting evidence |
| --- | ---: | ---: | ---: | --- | --- |
| 1. Optional typed Stack subpath plus a thin CLI route | 430-740 | 600-1,000 | 4-8 | 8 / 8 / 5 | Reuses package/process owners; must prove no resolution or installation cost for ordinary users and mandatory execution when selected |
| 2. Optional typed Stack subpath, consumer-owned CLI/CI wrapper | 340-570 | 450-800 | 3-6 | 7 / 8 / 4 | Smaller shared code; every consumer must correctly preserve cancellation, JSON and exit semantics; compare duplicate caller glue |
| 3. Separate optional Effect-check package using the same process library | 500-850 | 650-1,100 | 5-10 | 6 / 8 / 6 | Separates release cadence but adds another package/admission surface for a responsibility already owned by Stack |

Choose option 1 under the user's current authorization if both review rounds
confirm the bounded policy and package seam. Reassess if the implementation
materially exceeds these ranges; do not fill a quota with abstractions. Estimate
confidence is 6/10. Before later tool upgrades, compare a supported upstream
launcher with the selected native route; the inspected 0.73.4 JavaScript
launcher eagerly initializes TypeScript 5.9.3 and is not executable here.

## Proposed public contract

- Add `stack-toolchain/effect`, an explicit typed ESM entry with a capability
  contract marker and one check function. An older release must fail to import
  the new subpath rather than silently execute a different command.
- Add a thin `effect:check` CLI route with explicit project paths and existing
  text/JSON conventions. API and CLI call the same implementation.
- Inputs are consumer root, a bounded nonempty ordered project list,
  AbortSignal and bounded total time budget. No arbitrary executable path,
  shell command, compiler flags, callback plugin or environment override.
- Reports distinguish successful checking, policy diagnostics, invalid inputs,
  unavailable/incompatible tool, execution failure and cancellation. Retain
  observed codes/output within existing process bounds. No error-to-stock
  fallback; no successful partial check.
- Root imports, ordinary `typecheck`, `doctor`, lint and format do not resolve
  or install Effect. The selected platform package is an explicit exact consumer
  development dependency, not an npm optionalDependency installed for everyone.

The new source stays under the existing toolchain-execution owner, with pure
bounded policy validation separate from filesystem/process adapters and a thin
outer entry. Extract only a genuinely shared execution/path helper, preserving
existing behavior and tests. Do not impose a new directory layer for symmetry.

## Policy activation and source coverage

Native `--showConfig` omits Effect plugin settings in the qualified cohort.
Therefore compiler exit zero alone cannot prove activation. Select a small
explicit leaf-project contract instead of implementing TypeScript inheritance:

1. The selected local JSON/JSONC project explicitly declares exactly one Effect
   plugin. It is enabled, both unstable-use and stable-API-leak rules are errors,
   and error findings cannot be ignored in the compiler exit status.
2. Consumer exceptions name exact upstream exports. The first profile rejects
   file overrides and represents SDK/backend/frontend policy by separately
   selected standalone leaf projects. This keeps matching with the compiler
   and avoids a custom glob or suppression engine. Each selected project has
   an explicit exact allowlist; wildcards and unknown policy options reject.
   The already researched override shape remains a later additive choice.
3. The actual qualified compiler resolves ordinary TypeScript options. The
   implementation review narrowed this to flat standalone configs: selected
   projects reject `extends` because the native compiler retains hidden inherited
   Effect overrides, and `--showConfig` cannot expose the effective policy.
   Require strict/noEmit, no disabled strict-family suboptions, no noCheck or
   skipLibCheck, nonempty real source roots and no project references. Selected
   leaf configs and all consumer source files belong to the declared real source
   root. The compiler's complete source-list probe, not just showConfig roots,
   supplies imported local files too. Installed dependency declarations and
   paired standard libraries belong to their separately admitted physical
   installation boundary. The existing sibling fixture's node_modules link is
   admitted through its real installation, not treated as escaping local source.
   Every local implementation file in that inventory must also be an explicit
   effective canonical root through `files`/`include`; otherwise a workspace
   import may be skipped as an external library. Reject logical symlink aliases
   used as roots. Do not create a config/import resolver or temporary rewritten
   tsconfigs to infer or repair scope.
4. This strict optional profile admits exceptions only through its explicit
   exact-export config. Reject the reserved token `@effect-diagnostics` in all
   admitted consumer source files before checking, including imported local
   files. The lexical refusal deliberately also catches token text in a string;
   document this conservative restriction. Do not reinterpret directive syntax.
   Installed third-party declarations are not consumer suppression policy.
   Reject case-insensitive `@ts-nocheck` too, because the compiler otherwise skips
   the file before invoking Effect rules. Ordinary `@ts-ignore`/`@ts-expect-error`
   do not suppress the pinned compiler's Effect diagnostic codes.
   Actual unstable use with next-line off and wildcard skip-file directives
   must reject as policy input failures.
   Implementation review additionally identified that the pinned upstream
   runner skips declaration files. Reject consumer-local `.d.ts`, `.d.mts`
   and `.d.cts` sources, whether selected directly or imported, rather than
   imply Effect coverage for them. Installed declarations remain type-resolution
   inputs. This bounded restriction requires no declaration parser.
5. Every selected project is checked. The report preserves its inventory and
   outcome; cancellation, timeout, incomplete output or incomplete cleanup is
   failure. Do not classify an arbitrary nonzero exit as an expected diagnostic.
6. API leakage uses declared stability and the upstream default of stable for
   untagged exports. The retained public-contract examples explicitly use
   `@stability stable` to document intent, not to activate the rule. Exact use
   allowances do not exempt exported types from the separate leak rule. This
   does not automatically close all package exports, deep imports or FMS
   boundaries; those remain with their existing checks.

The consumer owns which projects and exact exceptions it selects. The command
proves that declared scope, not an independently discovered whole repository.
Tests must distinguish a missing/disabled policy from a valid policy with no
findings. Reject duplicate/conflicting plugin declarations and ambiguous inputs.

## Exact executable and dependency admission

Initial native profile: Linux x64, `@effect/tsgo-linux-x64@0.73.4`, reported
`7.0.2+effect-tsgo.0.73.4`; binary SHA-256
`18b0b3fdac7d76b8c9b97e64c185ce8d92f2e13ab2307ae18a27fb11a62c045c`.
Keep the published package and adjacent standard declarations intact. Resolve
from the consumer installation through the existing physical-containment
approach, enforce the exact package/executable identity before running it, and
reject unsupported platforms before compiler execution. Retain and verify the
already-qualified 108 paired standard-library filenames/digests as well as the
selected binary; missing/replaced libraries reject. Do not hash or execute the
package's unrelated bundled variants. Never run the rejected
JS wrapper, setup/patch command, TypeScript 5/6 or a private compiler fork.

All subprocesses use the existing node-or-bun execution/custody mechanism with
one overall deadline and cancellation. Version/config probes consume that same
budget. Typecheck uses the fixed flags `--noEmit --pretty false --incremental
true --tsBuildInfoFile <os.devNull>`; no build/watch mode or caller flags.
Version, effective-config and complete-source-list probes use closed flag sets.
An incremental/composite fixture with an explicit build-info path must prove
that source/config bytes stay unchanged and that no build-info output appears.
This needs a fixture assertion, not a new snapshot framework.
Known six-digit diagnostics and warning behavior need explicit handling;
unknown output, crashes, signals and capture/cleanup failures cannot become a
successful policy result. Keep ordinary typecheck's existing qualified semantics.

No new runtime dependency on Effect is added to Stack or Foundation. The shared
installed qualification uses exact public dependencies:

| Fixture dependency | Pin |
| --- | --- |
| `@get-modular/core` | 0.8.0 |
| `@get-modular/assembly` | 0.8.0 |
| `@get-modular/effect` | 0.1.1 |
| `effect` | 4.1.4, matching the GM adapter's exact peer |

Registry metadata/SRI and decoded provenance were inspected; this alone is not
cryptographic verification. A private fixture manifest and real npm lock own
these four pins plus the native compiler pin, with no root/Stack dependency
addition. Only Linux x64 prepares this cohort using the existing npm command
runner, `npm ci --ignore-scripts` and the official public-registry signatures /
provenance verifier. Retain exact upstream names, versions, lock/SRI identities,
verifier result and installed payload binding before any compiler execution.
Do not force the research pilot's Effect 4.1.5 into GM's exact 4.1.4 peer graph.

One small fixture-only preparation helper supplies both existing installation
owners. It does not build/pack candidates or become another orchestrator:

- Packed owner: `scripts/pack-test.mjs` prepares the exact public cohort before
  `createPackedConsumerFixture`; its existing manifest/catalog writer receives
  the selected exact fixture dependencies before installation. Preserve a real
  lock and frozen reinstall before the existing manifest normalization from
  tarball specs to published versions. Retain the cohort declarations in that
  normalized manifest and bind the same verified upstream payload.
- Registry owner: `scripts/registry-install-e2e.mjs` receives the acquired
  dependency roots in its existing closure/seeding flow and inserts exact pins
  into the selected Linux `foundation-full` consumer manifest before install.
  Supplemental upstream roots enter both the closure's collected seed set and
  traversal queue; they never become candidate targets or packageNames.
  Keep `uplinks: {}` and existing real-lock integrity/payload assertions. Add a
  scoped `npm ci --ignore-scripts` reinstall for that Linux consumer before
  execution. The shared qualifier never installs from public npm in this phase.
  Only this Linux cohort raises Verdaccio's publication-body limit to 256 MB,
  because the complete native archive needs more than its current 64 MB limit.
- Public upstream signature evidence precedes repack/reseed. Local Verdaccio
  publications and the unpublished Stack candidate have their existing artifact
  and payload evidence; neither inherits original public npm attestations.
  Existing reseeding adjusts publishConfig.executableFiles in a disposable
  manifest. Record that known normalization; compare executable/library bytes
  exactly rather than claiming unchanged entire package.json or archive SRI.
- Ordinary optionality is proved in the existing independently installed
  no-Effect Stack consumer, before any cohort addition there. Do not substitute
  a consumer already containing Effect as evidence of absence.

Unsupported hosts receive no Linux fixture dependency. Their ordinary installed
Stack checks, public API/types and explicit unsupported-platform refusal remain
in the existing portable inventory. Positive native execution is required in
existing Linux package and registry owners, with no new globally omitted test
file, workflow or installer authority.

## E2E and the useful scope extension

Reuse `scripts/packed-stack-toolchain-qualification.ts`, already reached by pack
and hermetic-registry qualification. Extend it once through a small typed helper
instead of adding a second build/pack/install orchestrator. Call the installed
public API/subpath and CLI, never a checkout-only import. Preserve the existing
package checks on all platforms; portable admission cases still execute in the
full matrix, and unsupported Effect platforms report the declared refusal.

The installed test consumer contains independently wired SDK, backend-adapter
and frontend-shaped boundaries. Prove a useful in-memory GM+Effect result and
one physical compatible dependency graph. Frontend-shaped means portable type
contracts without Node ambient types; it is not browser execution.

| Test family | Distinguishing accepted/rejected observation |
| --- | --- |
| Ordinary TypeScript | Valid source passes; TS2322 still fails through the public entry |
| Effect use | Stable use and bare unused import pass; actual/aliased unstable use rejects |
| Public surface | Owned structural port passes; annotated stable signature leaking an unstable type rejects |
| Narrow allowance | Allowed adapter export passes; adjacent export and separately selected SDK/frontend policy still reject |
| Activation | Explicit policy passes; missing, disabled, downgraded, conflicting or source-suppressed policy rejects |
| Tool admission | Exact contained executable and paired libraries pass; absent/wrong pin/hash/library/outside path/unsupported platform rejects |
| Execution | Expected diagnostics are distinct from timeout, cancellation, crash, unknown output and incomplete capture/cleanup |
| Input preservation | Incremental/composite check leaves sources/configs unchanged and creates no requested build-info output |
| Optionality | Independent ordinary Stack consumer remains usable without any Effect installation |
| Installed delivery | Packed and registry-installed candidate expose the same API/types/CLI; no source links repair missing payload |

Reuse the Research corpus and its independently authored expectations where
applicable, preserving provenance. Add only tests that distinguish a real new
integration risk; do not mirror internal functions with large trivial suites.

For the requested modest scope increase, reuse GM's byte-exact test generator
`tests/qualification/consumer-fixtures/growth/generate.ts` at commit
`330c28dbea1a3de812d3aee5ddb71ef829dee347`, Git blob
`fd53a3e60ff7215e1d3b99bc3597375874b01fba`, with source/license provenance and
strict typecheck. Its pinned license is Apache-2.0; preserve source/license
provenance and original bytes. Do not reimplement its algorithm or fetch moving
source in CI. Use N100 and independently assert exactly 703 generated TS files,
with the actual effective input inventory. Compare exact stock TypeScript 7.0.2
against the selected Effect-native 7.0.2 on the same unchanged sources, not the
normal tsrs-first fallback. Run one pair only in the Linux packed owner; registry
and other native lanes do not multiply the sample. A separate small enforcement
canary is outside the 703-file input and its invocation is recorded separately.
Record exact input hashes, compiler identities, wall times and memory only if
actually collected. This is a bounded compiler
cost sample on a Promise-based GM graph, not Effect runtime scale or a production
SLO. Existing GM N500/N1000 receipts remain separate; enlarge this sample only
if a concrete unresolved question requires it.

## Repository qualification and delivery

New maintained source/tests/helpers are `.ts`, included in required strict
projects. Package tests enter both test-shard and Windows-lane inventories.
Update feature/source-dependency/topology/public-export inventories for owned
files and the normal Stack Changeset. Preserve release-owned baselines,
unrelated agent work, accepted standards and current default tool pins.

1. Publish this coherent plan commit to one feature branch; open one Draft PR
   after applicable pre-PR checks. Keep subsequent commits on that PR and push
   each coherent commit promptly.
2. Round 1: independent architecture/process and installed-consumer reviewers
   challenge ownership, activation, false success and packaging. Record findings
   and exact plan identity; revise the plan.
3. Round 2: independently re-read the revised plan, check fixes and overengineering,
   and close material findings before implementing.
4. Implement the bounded public route and qualification, run owned-file cleanup,
   changed/fast/security and focused checks. Keep source/artifact observations
   separate. The supported Node profile is prepared by the repository tooling.
5. Independent code and integration review; fix material findings and rerun only
   affected verification plus required gates. Record actual LOC and limitations.
6. Freeze final PR head/base, request its documented full CI once, and inspect
   the complete Linux/Windows/macOS/Node matrix, coverage, CodeQL and identity.
   Queued/skipped states are not successes. A moving head/base requires its own
   evidence; no duplicate local full verify solely while CI is running.
7. Record exact-head independent review in the PR, owner squash under existing
   protection, then verify final attribution/tree and required post-merge CI.

GitHub plugin is the available authorized transport; gh is installed but has no
authenticated host in this environment. The documented single `ci:full` label
request remains available for the final snapshot. Reconcile any uncertain write
by reads; never blindly duplicate a label/request/merge. This does not alter
protection or the existing GitHub Free workflow-source trust limitation.

## Progress and review record

- [x] Fresh source/ownership/CI and published dependency inventory.
- [x] Initial written plan and explicit excluded scope.
- [x] Round 1 critique applied.
- [x] Round 2 critique applied; implementation scope frozen.
- [x] Shared command and installed consumers implemented; native execution pending.
- [ ] N100 bounded compiler-cost observation retained.
- [ ] Independent final code review and fixes complete.
- [ ] Exact-head required full CI passed.
- [ ] Merge and final-main verification complete.

Review receipts and measured outcomes will be linked here as they occur. Plans,
decoded metadata, local checks, hosted qualification and registry publication
are distinct claims. The next agent continues from these checked items and the
PR's actual head; it does not replay the already completed Research pilot.

### Round 1 receipt

Three independent read-only roles reviewed initial plan commit
`edc92b4482e75ba17514687319146142fa47dadd`, Git blob
`640db5123ff301b2c565c86df91b1f60ede4283d`, SHA-256
`b4cef9b552de3dfc59afa85bad0af9b6b86483d7eb287bfeaf744bdf8fa655a3`.
All returned **revise before implementation**. Their material findings and
applied decisions are:

| Role / finding | Applied revision |
| --- | --- |
| Architecture/process A1 | Reserve source diagnostic-directive token; inspect imported local source through the compiler inventory; no suppression parser |
| Architecture/process A2 | Fixed devNull build-info flags and input-preservation fixture |
| Architecture/process A3 | Reject file overrides initially; exact per-project allowances, effective strict-family checks and distinct physical boundaries |
| Architecture/process A4 | Verify retained paired-library inventory as well as native binary |
| Installed-consumer I1 / delivery D1 | Explicit pre-install owners, one Linux-only fixture metadata authority, no-Effect optionality consumer and portable refusal |
| Installed-consumer I2 / delivery D2 | Public signatures before hermetic seed; bind payloads and keep candidate/local registry claims separate |
| Installed-consumer I3 | Stock 7.0.2 paired baseline, independent 703-file census and separate canary; one Linux packed sample |
| Installed-consumer I4 | Real source root and installed dependency closure use distinct containment checks |

Source-directive behavior was checked in the pinned upstream
[parser](https://github.com/Effect-TS/tsgo/blob/aa2db44499067a798028cff9d3b1b9ca1e156f57/internal/directives/parser.go)
and [rule runner](https://github.com/Effect-TS/tsgo/blob/aa2db44499067a798028cff9d3b1b9ca1e156f57/internal/rulerunner/diagnostics.go).
Review itself did not execute a bypass fixture. Round 2 must check these revised
choices, particularly installed dependency acquisition and admitted source scope.

### Round 2 receipt and frozen scope

The same three independent roles reviewed revised plan SHA-256
`832afb8ad945861202c7aba1199c367ef1cccf5c61939cfd234138bea95d2a61`.
Architecture/process returned **approved for implementation** with A1-A4 closed.
Installed-consumer and delivery reviewers approved after the concrete corrections
now applied above: seed supplemental roots themselves, add the scoped frozen
reinstall at the correct manifest phase, and raise only the Linux cohort's
registry body limit. The known reseed manifest normalization is explicit.
No unresolved plan blocker remains. These reviews preceded implementation.

Implementation guardrails: actual runtime input/read/output/deadline bounds;
reports distinguish selected, attempted, completed and unattempted projects;
malformed compiler inventory rejects instead of falling back to root files;
signature verification stays in fixture acquisition, never a network prerequisite
of the public check API. No new general resolver, suppression engine, plugin
registry, snapshot framework or installation orchestrator is admitted.


### Implementation review in progress

The first independent production review found two material gaps: local declaration
files are skipped by the upstream Effect rule runner, and ordinary multiline
TypeScript diagnostics were classified as tool failures. The first is corrected
with explicit local-declaration refusal (including imports), portable cases and
an installed negative. The second now has a bounded English message-chain
classifier and an installed nested-assignment fixture followed by another
selected project. Its portable positive and crash-tail controls pass; actual
native qualification remains pending. Unknown message families still fail
conservatively with their raw output retained.

Independent installed-consumer review also required ordinary typecheck, lint and
format to run in the existing no-Effect installation, alongside root import and
doctor. Those assertions now share that installation and its Effect-resolution
blocking hook. Acquisition review required explicit development-dependency
inclusion even under a production environment; both frozen public install and
signature verification now request it.

Source build, strict script typecheck and Stack strict typecheck passed.
The subsequent focused run passes 27 checks after fixing two test-harness
issues (JSONC null-prototype records and Node test-runner stdout capture). These
are local source observations, not installed-native qualification. The native
acquisition attempt exhausted this shared workspace's temporary filesystem;
its incomplete payload was removed. No compiler or successful signature audit
is claimed for that attempt. Full packed and hermetic-registry qualification
remain required on the PR's final head.

Inventory review corrected the derived source topology through its existing
generator. The retained GM generator has one exact formatter exclusion to
preserve its upstream Git blob; its strict typecheck and runtime blob comparison
remain required. No source/test inventory or coverage boundary was removed.
The guide's copyable SDK project now uses the same explicit declaration libraries
as the installed qualification. Ordinary lint findings are fixed in source;
complexity/size limits are not waived for the new route.


### Scope reassessment and local gates

Physical line counts after review fixes are 874 in five new production files
(plus the thin existing CLI dispatch), 1,161 in four portable test files, and
1,207 in the four private acquisition/installed-qualification helpers. A further
111-line helper moves an existing packed-consumer installation block out of its
oversized fixture writer; it does not add a second installation owner. These
counts exclude retained corpus/generator/license bytes, manifests and guides.

The implementation is larger than the planning ranges, especially its installed
qualification. The additional cost is explicit: complete imported-source and
paired-library admission, original-package signature/payload evidence before
hermetic reseeding, independent no-Effect checks, source preservation, multiline
diagnostic controls and one reused growth observation. The scope retains one
public operation, one compiler cohort, one process owner and the existing two
installation routes. It adds no compiler abstraction framework, plugin registry,
config resolver, runtime service container or additional CI workflow. Independent
final review must reassess this measured scope, not treat the original estimate
as a quota or silently relabel fixture work as free.

After those source fixes, required `check:fast` passes (50,995 ms), including
strict projects, complete test inventories and source topology. Focused runtime
checks pass 27/27, production typed lint passes, and workflow security checks
pass. Final code review, installed native observations and exact-head full CI
remain separate acceptance items. Live delivery receipts belong to
[the single PR #476](https://github.com/agent-teams-ai/engineering-foundation/pull/476)
so the final merge and post-merge checks do not require a self-referencing source
commit.


### Independent whole-change review: native activation gaps

A reviewer who authored none of this change found three further native-specific
false-success paths. Each is resolved through a bounded explicit input contract,
not another compiler/configuration resolver:

| Finding | Required correction and installed negative |
| --- | --- |
| A workspace import through `node_modules` can be marked external even after realpath points inside the consumer | Every local implementation file must be an effective canonical root; omitted workspace source rejects, explicitly rooted unstable source must produce TS377136 |
| Case-insensitive `@ts-nocheck` prevents the compiler from invoking Effect rules | Reserve that token across all local source, including imports; root and imported actual-unstable fixtures must reject |
| Effect file overrides from `extends` survive explicit leaf policy and are absent from `--showConfig` | Reject selected-config inheritance in this first profile; a parent override disabling both rules must not yield success |

The first two conclusions follow the pinned TypeScript 7.0.2
[files parser](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/compiler/filesparser.go)
and [pragma parser](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/parser/parser.go).
Canonical configured roots start at depth zero, and lower depth wins regardless
of load order; only positive final depth marks an external-library source.
Pragma names are case-folded before deciding whether the checker runs. The
[Effect merge hook](https://github.com/Effect-TS/tsgo/blob/aa2db44499067a798028cff9d3b1b9ca1e156f57/internal/effectconfigraw/hooks.go)
retains/appends parent overrides rather than clearing them.

The useful next upstream question is an observable effective Effect policy or a
qualified policy reset, which could enable ordinary inherited configs later.
That investigation does not justify a custom inheritance engine in this PR.
The guide states these first-profile limits explicitly; a finished application
or arbitrary existing monorepo config is not assumed.

The local changed-check route was attempted again after source fixes. Its isolated
Node profile installed 706 packages from the existing store, then a child was
terminated by SIGKILL during bootstrap. The bounded diagnostic log was retained;
this is not a successful changed-check receipt. The shared workspace has limited
memory/temporary capacity. Repeating that allocation without a changed condition
adds no evidence; the complete required hosted matrix remains the delivery gate.


All three activation corrections above are implemented in source and the
portable suite now passes 30/30. The independent whole-change reviewer accepts
the measured scope and owner separation: pure policy, existing process adapter,
one shared installed qualifier and the cohesive extraction of an existing
installation block. No additional material source issue was found in provenance,
payload normalization, cancellation, exports or test inventories. The review
remains provisional until it is bound to the frozen PR commit and the native
controls have executed; source inspection is not substituted for that evidence.

The complete `check:fast` route was rerun after all three activation fixes and
passes in 52,442 ms; production typed lint also passes. This is the source
snapshot submitted for hosted installed/native qualification.

### First hosted qualification findings

[Full CI 45659578531](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/45659578531)
was explicitly requested for head
`c7145e3da2c0435eda488c631de6da09a8f536ca` on base
`fac03920e50ebde038ae415edeb7aa9e3d610ada`. Its failures exposed three
concrete integration corrections; this run does not qualify the corrected head.

| Observed boundary | Finding and correction |
| --- | --- |
| [Linux static](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/45659578531/job/139365677350) | Foundation source coverage rejected the double `unknown` cast in native-manifest parsing. Build the result from individually validated values instead. The complete local lint route, including that gate, then passes. |
| [Linux registry](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/45659578531/job/139365677224) | Public acquisition and signature/provenance verification passed for all five packages, but copying the native payload exceeded the ordinary 256 MiB aggregate staging limit. Supply an explicit bounded byte budget only after verifying this exact coordinate/SRI and its 333,854,566-byte inventory; require the copied total to match. |
| [Windows packed consumer](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/45659578531/job/139369797515) | All four ordinary no-Effect commands returned exit zero. The fixture incorrectly rejected the existing `passed-with-fallback` status of ordinary typecheck. Accept that declared status only for this command; retain exact command order, zero exit codes and `passed` for doctor, lint and format. The Effect route still has no compiler fallback. |

The public acquisition receipt used npm 11.20.0, completed in 5,157 ms, and
verified the exact fixture manifest and lock digests
`c1fd1874364a3771661e9238316bd5b03230526ef28640bd6ab98708ed10429b`
and `0299a522c4c2d5ea6d65ef3b35ac3a5b752c2415492359a26307a7d05c6eef7d`.
The observed payload census was:

| Original public package | Files | Bytes |
| --- | ---: | ---: |
| `@effect/tsgo-linux-x64@0.73.4` | 588 | 333,854,566 |
| `@get-modular/assembly@0.8.0` | 44 | 145,822 |
| `@get-modular/core@0.8.0` | 52 | 217,883 |
| `@get-modular/effect@0.1.1` | 19 | 86,178 |
| `effect@4.1.4` | 3,058 | 58,073,105 |

This is evidence about original public packages. It is not provenance for the
local registry's repack or the unpublished Stack candidate, and does not prove
that the native diagnostics or N100 measurement executed. The registry attempt
stopped before those checks; the Linux package job depended on failed static
qualification and was skipped.

The staging correction extends the existing shared reservation state with one
optional positive safe-integer bound. Ordinary stages retain their existing
limit. Three small local regression cases pass: concurrent reservations under
default/custom limits, aggregate tree acceptance/rejection at the byte boundary,
and invalid untyped limits. The permitted `package.json` normalization is
reported separately from the original copied total; installed payload binding
remains required. This is narrow maintenance of the existing legacy registry
owner, not a new packaging framework or a claim that that legacy file is fully
strictly typed.

Independent source review approved the manifest/staging correction and required
the installed suppression fixture to use the real upstream
`@effect-diagnostics *:skip-file` syntax; that correction is included. Final
review must bind to the corrected commit, and a newly requested complete native
matrix must establish installed diagnostics, ordinary optionality and growth
observations before merge.

After these corrections, the complete local `check:fast` route passes in
50,921 ms and the complete lint route passes, including strict typed lint and
Foundation's source-coverage gate. These receipts cover the corrected source;
they do not replace the next native installed qualification.

### Joint-rule oracle distinction

Targeted source review before the next native run found a distinction hidden
by the original pilot's separate rule configurations. Its stable-leak fixture
disabled unstable-use diagnostics, whereas the shared gate requires both rules.
The pinned
[usage visitor](https://github.com/Effect-TS/tsgo/blob/aa2db44499067a798028cff9d3b1b9ca1e156f57/internal/rules/stability_api_usage.go)
also inspects type references. The
[leak walker](https://github.com/Effect-TS/tsgo/blob/aa2db44499067a798028cff9d3b1b9ca1e156f57/internal/rules/api_stability_leak.go)
checks every public export, and the
[type parser](https://github.com/Effect-TS/tsgo/blob/aa2db44499067a798028cff9d3b1b9ca1e156f57/internal/typeparser/api_stability.go)
defaults an untagged export to stable. A copied single-rule oracle therefore
cannot be assumed to describe the joint profile, including usage fixtures that
export inferred HTTP types.

The original source bytes and original expected diagnostics remain retained.
The installed qualifier now emits the whole bounded eight-case observation
before exact assertions, so one native run can expose every joint-profile
difference. No expected code/line set is weakened or generated from current
output. Any revised joint oracle must record its distinct policy and independent
reasoning, then pass a later actual native run.

Separate allowance, workspace-root and CLI-use controls now export a stable
boolean while retaining a real `get(...)` expression. This isolates the intended
use/coverage check from public-type leakage without disabling either rule. The
guide explains that an exact adapter allowance does not authorize leaking the
unstable HTTP result through a stable SDK. These source-derived conclusions
remain distinct from pending installed execution.

The follow-up local fast-check attempt passed formatting, complete inventories,
strict typecheck and source scope/topology, then its architecture-features child
was terminated by SIGKILL (27,518 ms total). The full command did not pass on
this follow-up snapshot; no source diagnostic or precise termination cause was
reported. The next complete hosted matrix must supply the missing qualification.
