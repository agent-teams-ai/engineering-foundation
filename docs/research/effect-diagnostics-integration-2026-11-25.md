# Optional Effect diagnostics in Stack Toolchain

Date: 2026-11-25. Status: plan; implementation has not started. Owner:
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
2. Consumer exceptions name exact upstream exports. If file overrides are
   admitted, they may change only exact allowances, not disable required rules
   or weaken severity. Preserve replacement semantics. Unqualified policy shapes
   reject with a bounded configuration error rather than being guessed.
3. The actual qualified compiler resolves inherited ordinary TypeScript options.
   Require strict/noEmit, no noCheck or skipLibCheck, nonempty real source roots
   and no project references in this first standalone profile. Reject omitted
   or escaping source/config paths under the declared root policy. Relative
   file semantics must be qualified; do not create temporary rewritten tsconfigs.
4. Every selected project is checked. The report preserves its inventory and
   outcome; cancellation, timeout, incomplete output or incomplete cleanup is
   failure. Do not classify an arbitrary nonzero exit as an expected diagnostic.
5. API leakage is annotation-driven in the upstream rule: the retained positive
   and negative public-contract examples explicitly use `@stability stable`.
   This does not automatically close all package exports, deep imports or FMS
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
reject unsupported platforms before compiler execution. Never run the rejected
JS wrapper, setup/patch command, TypeScript 5/6 or a private compiler fork.

All subprocesses use the existing node-or-bun execution/custody mechanism with
one overall deadline and cancellation. Version/config probes consume that same
budget. Known six-digit diagnostics and warning behavior need explicit handling;
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
cryptographic verification. Frozen installations, actual package identity and
the official npm signatures/provenance verifier must pass before native fixture
execution. Retain the actual result and do not invent unpublished attestations.
Do not force the research pilot's Effect 4.1.5 into GM's exact 4.1.4 peer graph.

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
| Narrow allowance | Allowed adapter export passes; adjacent export/outside source still rejects |
| Activation | Explicit policy passes; missing, disabled, downgraded or conflicting policy rejects |
| Tool admission | Exact contained executable passes; absent/wrong pin/hash/outside path/unsupported platform rejects |
| Execution | Expected diagnostics are distinct from timeout, cancellation, crash, unknown output and incomplete capture/cleanup |
| Optionality | Ordinary Stack entry and commands remain usable without any Effect installation |
| Installed delivery | Packed and registry-installed candidate expose the same API/types/CLI; no source links repair missing payload |

Reuse the Research corpus and its independently authored expectations where
applicable, preserving provenance. Add only tests that distinguish a real new
integration risk; do not mirror internal functions with large trivial suites.

For the requested modest scope increase, reuse GM's byte-exact test generator
`tests/qualification/consumer-fixtures/growth/generate.ts` at commit
`330c28dbea1a3de812d3aee5ddb71ef829dee347`, Git blob
`fd53a3e60ff7215e1d3b99bc3597375874b01fba`, with source/license provenance and
strict typecheck. Do not reimplement its algorithm or fetch moving source in CI.
Use N100 (703 generated TS files), one ordinary baseline and one Effect-enabled
pass plus a separate enforcement canary. Record exact inputs, compiler identities,
wall times and memory only if actually collected. This is a bounded compiler
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
- [ ] Round 1 critique applied.
- [ ] Round 2 critique applied; implementation scope frozen.
- [ ] Shared command and installed consumers implemented.
- [ ] N100 bounded compiler-cost observation retained.
- [ ] Independent final code review and fixes complete.
- [ ] Exact-head required full CI passed.
- [ ] Merge and final-main verification complete.

Review receipts and measured outcomes will be linked here as they occur. Plans,
decoded metadata, local checks, hosted qualification and registry publication
are distinct claims. The next agent continues from these checked items and the
PR's actual head; it does not replay the already completed Research pilot.
