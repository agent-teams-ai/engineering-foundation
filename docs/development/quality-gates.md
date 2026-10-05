# Quality Gates

Status: Active on this repository; reusable presets ship in the current published
package.

## Feedback layers

The checks are intentionally layered so agents get fast feedback without
weakening the merge gate.

| Layer | Command | Purpose |
| --- | --- | --- |
| Changed | `pnpm check:changed` | Foundation-routed checks for the current Git delta |
| Fast | `pnpm check:fast` | Terminology contract, fail-closed test manifests, Oxlint syntax/correctness, and pinned TypeScript 7 |
| Terminology | `pnpm docs:terminology:check` | Canonical glossary sections, qualification scopes, and entry-point links |
| Architecture | `pnpm foundation:check` | All declared deterministic capabilities, including docs and ADR governance |
| Workflow security | `pnpm security:workflows` | Pinned Actionlint and Zizmor capability qualification for all workflows and local actions |
| Buf capability qualification E2E | `pnpm buf-qualification:e2e` | Real pinned Buf `FILE` compatible, breaking and fabricated-evidence scenarios |
| Patterns | `pnpm architecture:patterns` | Consumer-owned deterministic AST prohibitions |
| Dead code | `pnpm dead-code:check` | Unused files, exports, types, and dependencies |
| Full | `pnpm check` | Complete deterministic package and consumer conformance with coverage thresholds |
| Full PR request | `pnpm ci:full -- --pr N --wait` | Explicit complete native qualification bound to the final PR head and base |
| Local diagnostic | `pnpm verify` | Local sequential equivalent of all required Linux evidence |
| Coverage | `pnpm test:coverage` | Local native Node coverage-threshold qualification for lines, branches, and functions |
| Partitioned coverage | `pnpm test:coverage:evidence:built -- --input <artifacts> --head-sha <sha>` | Blocking CI coverage qualification of exact-head raw V8 evidence from the eight isolated Linux test shards |
| Performance | `pnpm test:performance:built` | Advisory 100/1,000/5,000-document timing evidence outside the pull request gate |

Foundation's self-dogfood lifecycle is explicit and ordered:

1. `pnpm foundation:bootstrap` builds current workspace source with the pinned
   compiler and package manager, without invoking the Foundation CLI.
2. `pnpm foundation:dogfood` runs the freshly built Foundation CLI against this
   repository. Existing CI jobs may use `foundation:check:built` only after their
   preceding build step succeeds.
3. `pnpm foundation:qualification` first repeats that source dogfood, then runs
   artifact qualification against packed and hermetic-registry artifacts and
   finally runs the pinned published-
   version compatibility oracle. Published versions never govern current-source
   checking.

The private root may link Foundation with `workspace:*` for tool resolution. The
published Foundation manifest cannot depend on itself, Foundation source cannot
depend on Docs Protocol, and no bootstrap package or published dependency cycle
is part of this lifecycle.

`pnpm check` is the deterministic repository and package conformance layer. It
does not claim networked, hosted, or external-tool capability qualification. `pnpm verify`
is the single local command matching the union of Linux merge lanes: workflow
security, the deterministic check, Buf, hermetic registry installation, published-version
compatibility, dead-code analysis, and parser parity.

Partitioned c8 coverage is the blocking Linux CI coverage authority. Each
existing Linux test shard writes raw V8 coverage without rerunning its tests. Its
sidecar binds the full Git SHA, exact Node and c8 versions, coverage-config
digest, test-manifest digest, shard identity, test list, and every raw-file
digest. The aggregator accepts exactly one artifact for each of shards 1 through
8, rejects missing, unexpected, mixed, duplicate-claim, or modified evidence,
retains the exact bounded bytes it validated, merges once, and applies the
separate c8 floors of 70% lines, 77% branches, and 78% functions. The promoted
floors are below the observed exact-head CI result of 71.88%, 78.97%, and 79.86%
respectively. `c8` is used only for merge/report because the Node test runner can
emit raw V8 JSON but cannot consume coverage from completed processes.

The evidence merger owns `c8` as a pinned CLI-only dependency, so Knip excludes
that dependency from import-based usage detection. Its process-tree fixture is
an explicit Knip entry because Node launches it directly rather than importing
it from the test module.

The transaction architecture counterexamples in
`tests/foundation-local-mode-transaction-e2e.test.mjs` generate imports of
`foundation-state-contract.ts` and `schema-ids.ts` inside disposable copies.
These two files are explicit Knip entries because those generated imports are
not visible in its static test graph. Other internal facades remain subject to
unused-export checks.

The shard's test result, all eight artifact uploads, evidence aggregation, and the
stable `linux-coverage` context are fail-closed. An evidence setup or sidecar
finalization failure may preserve the original shard test result, but the
required upload or merger then fails. Raw instrumentation still shares each
shard's test process and its timeout.

The former standalone native Node CI lane and the partitioned-coverage kill
switch are removed. Native Node coverage remains available locally through
`pnpm test:coverage` and remains part of `pnpm check` and `pnpm verify`; its
thresholds stay separate because Node and c8 calculate the measured universe
differently.

Required CI executes the same evidence as independent jobs. Linux uses eight
checked-in serial test shards in four fixed pairs. Each pair runs two producers
concurrently, with separate Git checkouts, dependency installs, builds, test
processes and temporary directories. All eight producers remain mandatory and
upload their own exact-head raw evidence; fail-fast is disabled, and the coverage
aggregate requires the entire matrix. Only producer 4 receives the declared
managed consumer tools. A producer failure drains the other started producer,
retains both exit statuses and fails the job.

Each pair has a 25-minute bound. Release admission accounts for any configured
matrix batches, keeping the configured Linux path below the unchanged 72-minute
Windows bound. Queue delay remains outside job timeout arithmetic. Pairing
reduces runner slots from eight jobs to four; performance is measured on native
CI, rather than inferred from job counts.

The evidence aggregator accepts only the canonical checkout layout or the
complete fixed paired layout (odd shards in `a`, even shards in
`b`). Mixed layouts and unexpected roots fail. After validating the
original bounded bytes and their sidecars, it projects the trusted producer
paths in derived c8 input copies onto its checkout. Original raw evidence,
function ranges and execution counts remain unchanged.
Windows uses five isolated lanes: C contains only
the installed loader CLI suite; A, B, D and E use the independently balanced
checked-in Windows partition. Its closed dispatch validates the complete canonical
inventory before platform filtering and requires the exact portable union once.
Missing pinned entries, duplicate assignments, incomplete partitions and new
unassigned files reject dispatch until the Windows policy is updated explicitly.
Raw coverage-only suites stay
Linux-only and are distributed across the same eight exact-head producers.
Package, registry, published-version, coverage and static qualifications run in
parallel checkouts. The stable required contexts `check` and `windows-check`
reject a failed, cancelled, skipped or missing prerequisite, including every
new test job. Every executable pull request job depends directly on Dependency
Review. Both aggregates retain the complete Node 24/26 compatibility matrix.

The static partition uses all 281 whole-file timing records from successful
[CI run 37154414643](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/37154414643)
at `331e97758fd83e6a0da69a3400b3bfe8aa8d0aee`. Paths match the most-specific
inventory suffix, so a package test cannot inherit a same-named root test's
measurement. A longest-first assignment minimizes the larger normalized Linux
raw-coverage (440 seconds) and portable Windows (450 seconds) load; ties use
Linux load, then numeric shard ID. Loader stays in shard 3; both Linux-only
managed suites stay in shard 4 with its pinned Node 26 tools. Original relative
order is retained inside each resulting canonical and raw-only list. All existing 239
canonical and 42 raw-only files, exact mandatory identities, no-skip enforcement
and `--test-concurrency=1` remain intact. The new materialization regression suite joins shard 5, bringing
the prior inventory to 282 files. The private full-CI request regression suite is
pinned in canonical shard 5 and Windows lane B, bringing the inventory to 283 files. Every test checkout retains Git history
for committed-delta checks.

The resulting projections are about 439 seconds per Linux shard and at most
448 seconds per former Windows lane, except for the isolated loader. That
nine-lane candidate increased runner contention. The independent five-lane
Windows partition projects about 734 seconds per residual lane and retains the
loader as its own lane. These
are estimates from one run, excluding setup, queueing and future variance.
The Windows policy uses longest-processing-time-first assignment across A, B, D
and E using Windows timings alone, with canonical traversal order and then lane
ID as tie-breakers. It preserves that traversal order inside each resulting lane.
The new materialization suite is unmeasured and contributes zero only to this
advisory projection; it remains mandatory at execution.
Final exact-head Linux, Windows and macOS CI must establish actual behavior.

Before opening a PR, run the changed and fast gates, workflow security and
focused checks for the changed behavior. Merge still requires independent
technical review and the explicitly requested complete `full-ci` matrix on the
final PR head and base, including all native
qualifications and the partitioned coverage authority. A second sequential local
`pnpm verify` is not an additional merge prerequisite when CI supplies that
evidence. Keep the full local diagnostic command when full CI cannot run or a
changed risk is not covered; retain any uncovered check. Pending CI alone does
not require a duplicate local full run. Older-SHA results cannot be relabeled as
current-head CI.

The Windows loader remains isolated. A candidate compile-cache experiment did
not shorten its native Windows job and is not enabled. All Linux raw coverage
producers explicitly set `NODE_DISABLE_COMPILE_CACHE=1`, since compiled functions
can yield less precise V8 coverage. No cache substitutes for native qualification.

All Windows static, test, package, registry, and published-version jobs
set `TEMP` and `TMP` to the trusted runtime `RUNNER_TEMP` value through
`GITHUB_ENV` after Node setup and before install, rebuild, build, or test
subprocesses. A missing value fails the setup step. Linux and macOS retain their
default temporary directories.

[Windows experiment 37034137614](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/37034137614)
measured 27:16 with `C:\Users\RUNNER~1\AppData\Local\Temp` versus 14:42 with
`D:\a\_temp`: 1.855x faster, saving 754 seconds. Both variants qualified all
34 build commands and two independent clean builds; all six archives matched
versions, byte counts, and SHA-256 digests through the final post-process hash
barrier. Defender was already disabled and unchanged. The experiment used source
`a983c0ef2fdfc147508d1a9168a14f1e5a9f803c`; it is bounded baseline evidence,
not a timing promise or artifact qualification for the current head. Existing
timing and coverage workflow assertions and exact-head Windows CI must verify
the final configuration.

Shard invocations may pass `--timing-output <dir>` to retain advisory per-file
and per-test Node timings as `events.jsonl`. The mandatory path observes named
completion events through the existing setup hook; its identity verifier remains
the only stream consumer. The hook preserves the prior setup result, including
asynchronous completion and rejection. Other shards keep TAP output alongside a
private timing reporter. The parent writes records after the verdict, with write
failures reported as warnings. Timing directories must be outside coverage
evidence, including aliases. CI uses a separate runner-temp directory for each
invocation and retains timings for 14 days, even when tests fail. Missing or failed
timing uploads are advisory. Timings do not qualify mandatory identities or
coverage. The timing observer remains passive: it does not select a partition
or change serial test concurrency. Redistribution requires a separately reviewed
manifest change.

The required macOS qualification runs the real packaging containment tests via
`node scripts/run-selected-tests.mjs tests/tooling.test.mjs`. Its transient and
persistent retained-zombie cases are mandatory identities in
`architecture/foundation/node-test-execution.json`: neither skip nor omission
is admitted on Darwin. Exact `skipped` exceptions apply only on Linux and
Windows, whose kernels do not supply these Darwin semantics. Python3 must be
available on macOS; a missing interpreter fails the tests.

Ordinary and Draft PRs receive automatic `PR Feedback` on opened, synchronize,
reopened and ready-for-review events. Its blocking Dependency Review and SBOM
precede dependency execution. The repository security baseline names this automatic
workflow as its Dependency Review and SBOM authority. They are followed by
`check:changed --base <PR.base.sha>`
with complete history. CodeQL and identity retain their existing automatic
triggers. Fast feedback can be green while a required `full-ci` remains
Expected and blocks merge; passing feedback never qualifies the native matrix.

Near merge, the agent requests full qualification without a Draft transition or
human approval for each PR:

```bash
pnpm ci:full -- --pr 123 --wait
```

Run this private helper from a trusted checkout of the base repository. Do not
execute a fork-provided helper with a maintainer write credential.

The private helper resolves the canonical repository and open PR, including fork
PRs. It adds `ci:full` in the base repository. The actual `pull_request: labeled`
event admits every existing Linux, Windows, macOS and Node 24/26 lane. A label
left on a PR does not request full CI on later pushes; synchronize receives fast
feedback and cancels obsolete full work through the shared PR concurrency group.
Opened, reopened and ready-for-review feedback use a separate group, so delayed
metadata events do not cancel an explicitly requested same-head qualification.
Other labels use independent run groups and cannot create or overwrite any of
`full-ci`, `check`, `windows-check` or `macos-qualification`. Removal is not a
trigger. Distinct `ci-not-requested` job names prevent skipped checks on unrelated
label events from satisfying these required gates.
The shadow classifier remains advisory and cannot select or omit a native lane.

`full-ci` runs in parallel with the three stable native aggregates. It requires
successful Dependency Review and the complete union of their mandatory native
jobs using pinned alls-green, with no skipped/neutral allowance. A regression
checks that union so future lanes cannot be omitted. Its run
name binds PR number, head SHA and base SHA. The helper reuses successful or
in-progress runs only after checking that binding, canonical workflow ID/name/path,
event, source repository/ref, PR association, run ID and attempt. Fork runs can
omit GitHub's PR association array: those require a distinct fork repository,
its exact branch and the frozen PR/head/base title; contradictory associations
are rejected. Empty same-repository associations cannot qualify. Fork approvals
remain prerequisites. GitHub's run name carries
the immutable request title; workflow metadata separately identifies `CI`.
Success additionally requires one actual successful bound job for each of
`full-ci`, `check`, `windows-check` and `macos-qualification`. A label alone is
never evidence. Failed/cancelled work or an old
snapshot requires a new request, removing/re-adding an existing label when
necessary. An uncertain write is reconciled through reads, never blindly retried.
Discovery is limited to three 100-entry pages per collection and twelve request
observations five seconds apart, with a 20-second bound per CLI metadata call.
Transport reads retry at most three times with 250/500ms backoff; malformed JSON
is rejected immediately. One agent owns label mutations per repository/PR; the
static label is not a distributed lock. GitHub concurrency does not guarantee
event ordering: a delayed synchronize can cancel a fresh request, requiring a
new request after inspecting that cancellation.
`--wait` uses a bounded 90-minute watch, then rereads the run, native gate and PR.
A head/base change or unsuccessful result fails closed; rerun the command for
the final snapshot. `ready` describes observed full qualification; independent
current-head review and all other required checks remain separate obligations.

Main pushes, merge groups and workflow dispatch still run the complete native
matrix. Dispatch checks do not satisfy ordinary PR rulesets. Generated release
PRs retain the existing trusted exact-head/base attester: it prefers one bound
attempt-1 PR run with the immutable admitted full-request title, otherwise
dispatches CI, and now attests `full-ci` alongside
`check`, `windows-check`, `macos-qualification` and separate CodeQL `analyze`.
Every pending, terminal and recovery pass includes the new context. Five status
contexts reserve 570 seconds, up from 456, requiring a 92-minute attester bound
(up from 90); the 75-minute CI deadline and raw/native budgets are unchanged.
The original native and aggregate timeouts remain intact. The new parallel
metadata gate takes one minute, preserving the 72-minute configured critical
path plus three-minute attestation margin. Queue time remains outside job timeout
arithmetic. Strict up-to-date branch protection remains required.

The label/gate delivery contract can be shared through the organization `.github`
standard; concrete GitHub orchestration and this product's native matrix belong
to the repository Host. This helper is private and declares no published API.

New CI tooling and test harnesses use `.mts` and run with the pinned Node's native
TypeScript stripping. `typecheck:ci-tooling` checks their contracts with the pinned
compiler as part of `typecheck`; stripping alone is not a typecheck. The blocking
test inventory admits `.test.mts` with the same exact-once shard requirements.

Repository protection requires the stable exact-head contexts `CodeQL`,
`analyze`, `check`, `windows-check`, and `macos-qualification`. The integration
owner must add required `full-ci` only after observing a successful actual PR
request on the final implementation; each new head must then supply that check. Independent
hosted-review evidence belongs in pull-request comments; it is not converted
into a workflow-authored or self-attested status check. `ReviewGate` is retired.

`tests/manifests/test-shards.v1.json` owns the complete shard inventory.
`architecture/foundation/node-test-execution.json` declares Foundation's
mandatory Node case identities. Built, shard, coverage, and focused QGR scripts
fail when the contract is missing or invalid. Selected files with adopted
identities use structured completion evidence; other selected files still run.
Case variants and hard links to an adopted file are rejected before dispatch,
including selections that also contain a canonical adopted file.
The test manifest check requires every adopted file to belong to a required
shard. Platform skips outside the declared identities retain their ordinary
Node behavior. See [mandatory Node test execution](../reference/quality-gate-runner.md#mandatory-node-test-execution).
QGR synthetic and real-pnpm lifecycle capability qualification retains exact-once
placement in the checked-in shard manifests.
The native Darwin job required by `macos-qualification` deliberately reruns the focused QGR
lifecycle command after its Darwin build, including entrypoint cancellation and
POSIX containment evidence; it does not rerun the complete shard.
`tests/manifests/coverage.v1.json` pins their coverage-only additions, the
merger, production include/exclude boundaries, c8 evidence thresholds, and the
separate legacy Node coverage thresholds and test selection. The two threshold
authorities remain explicit because Node and c8 do not calculate every metric
identically. Together the manifests are the closed inventory of
repository and Docs Protocol test files. `pnpm test:manifests:check` rejects missing, extra,
duplicate, nested, non-portable, or symlinked test entries and malformed
coverage configuration. Add or rename a test and update the shard manifest in
the same change. Each shard's `tests` remain in the required inventory;
repository selection routes only the two private managed-runtime observation/process
suites to Linux x64, matching their [linux/x64 support contract](../reference/node26-managed-runtime-observation.md).
`check-test-manifests.mjs` owns this finite two-path policy and rejects missing,
renamed or additional managed-runtime suites until their platform policy is reviewed.
Built, shard and legacy coverage runners apply the same platform/architecture selection.
They report requested/selected counts and exact Linux x64-only paths; an empty dispatch refuses.
The global inventory is validated against both manifests: Linux x64 admits every
inventoried file; Windows, Darwin and other Linux architectures route only the
two private managed suites to Linux x64. Required shard counts exclude the unchanged coverage-only additions;
every portable required file and every declared mandatory identity remains selected.
The portable managed-profile suite checks unsupported-platform refusal before IO,
including Linux selections on actual unsupported hosts. The existing inert construction
and unadmitted-close case lives in that portable suite as well. Such refusal is rejecting
evidence, never a positive Linux runtime observation. Mandatory adoption of either
Linux-only file requires a reviewed platform contract; the existing versioned
mandatory contract and its exact identities remain unchanged.
Raw coverage selection requires Linux x64 and retains the complete inventory across eight shards.
The coverage manifest's `additionalTestsByShard` extends only the Linux
raw-evidence run with suites that passed capability qualification elsewhere but are needed
for the complete coverage universe. Keep
`--test-concurrency=1` inside a shard because recovery tests intentionally share
process and filesystem assumptions.

The scheduled `Performance signals` workflow records benchmark JSON and a Job
Summary, but has no absolute blocking threshold. The separate read-only `CI
feedback` observer reads completed-run metadata from the GitHub API, reports the
slowest lanes, and retains a source-bound JSON artifact for 30 days. It checks
out only the protected default-branch observer code, never pull request code.
Cancelled obsolete runs remain normal: agents use `check:changed`, `check:fast`,
workflow security and focused risk checks before PR handoff. Merge requires
independent review and complete successful current-code CI; the sequential local
`verify` diagnostic is needed only for unavailable CI or a risk CI does not cover.

Knip is blocking in the Linux CI job but is not repeated by Windows or the fast
local loop. Nx supplies project discovery, affected builds, and caching; it does
not define architecture policy. Ast-grep owns narrow syntax patterns such as
ambient clock, environment, randomness, and timer access. The foundation source
dependency capability is the only authority for package and architecture edges.
Actionlint and zizmor are independent external gates run through the
repo-owned Aqua bootstrap. It accepts only Aqua v2.62.3, uses a locally exact
copy when available, otherwise downloads one committed SHA-256-verified
macOS/Linux release archive into a private user cache with an atomic,
lock-protected install. The bootstrap has no floating installer script or
checked-in binary. Windows returns an explicit unsupported-platform
precondition, and the Windows CI job does not invoke this gate. Aqua then
enforces the committed registry and tool checksums in `aqua.yaml` and
`aqua-checksums.json`. Actionlint discovers all workflow YAML files without a
shell glob; Zizmor scans the repository root with strict collection, including
local composite actions outside `.github`. Dependency Review is a direct
prerequisite of every executable pull request job and is included by both
required aggregators. CodeQL runs as a separate hosted analysis; none of these tools execute
inside a normal capability check.

## Feature ownership and complete production scope

`pnpm quality:scope:check` retains EF-specific inventory, language, ambient-rule coverage and exact ambient exception validation. The [shared quality capability](../reference/quality-source-coverage.md) owns independent source/suppression coverage and actual Oxlint selection: `quality:coverage:scope` runs in the fast gate, and `lint:typed` runs the full CLI once in the full gate. `pnpm architecture:features:check` executes the [local adoption](../architecture/feature-module-standard.md) guard, including actual source edges. Both run in `check` and `check:fast`; unresolved ownership migrations fail closed. Typed lint covers every production `src`, including packaged qualification code, with unchanged rules and thresholds.

## Dependency updates

Dependabot checks npm dependencies and pinned GitHub Actions every weekday. It
opens ordinary pull requests; no dependency update is automerged. Every update
must pass the same Linux, Windows, package, dependency-review, and independent
review gates as a handwritten change.

Major `@types/node` updates remain on the accepted Node runtime line until a
reviewed toolchain decision changes it. Major TypeScript updates are also manual
because the repository owns a primary compiler and a separate parser-oracle
compatibility lane. Related non-major API Extractor and Oxc updates are grouped
so their coupled evidence is reviewed together.

## Lint contract

Oxlint is the only JavaScript/TypeScript linter until a concrete missing rule
proves that ESLint is required. The published presets enable correctness,
suspicious, import, promise, Node, Unicorn, Oxc, and type-aware TypeScript rules.

The repository also publishes opt-in production and test maintainability
presets. Foundation dogfoods the production profile and applies the documented
relaxed profile to tests, fixtures, the packed-consumer harness, and spikes.
Generated and vendored paths are excluded from the five budgets without
disabling unrelated lint rules; dependency and build output is ignored.
Consumers own their path mapping and enable the presets only in a dedicated
reviewed adoption change.

`typeCheck` remains disabled in Oxlint. The pinned TypeScript 7 compiler is the
single type-error authority, preventing duplicate and inconsistent diagnostics.
ESLint disable comments do not suppress foundation rules, and unused Oxlint
disable directives are errors.

## Architecture contract

Every governed source file must belong to a consumer-owned opaque boundary.
Each boundary declares its allowed boundary, package, builtin, and non-literal
runtime-reference edges. Workspace package identity, dependency declarations,
and export surfaces come from package manifests rather than duplicated YAML.

The gate is fail closed: new unclassified files, parser errors, cross-package
relative imports, undeclared packages, blocked exports, and unresolved imports
fail CI. The repository dogfoods separate application, contract, adapter, and
composition boundaries for every implemented capability.

The source-dependency schema requires explicit target entrypoints and rejects
runtime or type-only dependency cycles between packages and architecture
boundaries.

The repository dogfood uses source-dependencies v2 and `packageRoots:
[packages]`. The explicit package-root contract, rather than pnpm selection
globs, closes package and source ownership: a new direct child package, a source
outside governed roots, or a boundary spanning package roots fails the gate.
The package inventory test independently proves that every public workspace
manifest appears in the existing public API, release, and registry artifact-qualification
authorities without maintaining another package catalog or release graph.

Suppression waivers, released API baselines, privileged workflow jobs, and
publishable packages are also closed-world evidence. Released contract and API
baselines are release-owned: creation, replacement, movement, and deletion are
forbidden in a normal pull request. Contract baselines use the stable
`architecture/contracts/` root; accepted ADR history uses the single
`architecture/decisions/accepted-decisions.json` anchor.

## Conformance

The test suite includes positive and negative capability fixtures, real lint
failures, local attach/detach recovery, parser parity, ast-grep rule tests, and a
packed-tarball consumer. The tarball consumer installs its own exact Oxlint,
oxlint-tsgolint, and TypeScript versions and proves the published type-aware
preset, the source graph, documentation links and anchors, idempotent ADR baseline
promotion, and both contract-evolution capabilities.
Linux CI separately runs the real Aqua-pinned Buf capability-qualification E2E because the
normal capability and package checks are intentionally process-free. The E2E
proves compatible and breaking `FILE` behavior plus rejection of modified
committed evidence after a fresh Buf rerun.
The tarball is extracted and searched for a source-owned secret canary. Linux CI
also emits an SPDX JSON SBOM after Dependency Review succeeds.

That tarball check qualifies package contents and packed-consumer behavior, but
does not prove publication through an npm-compatible registry. Release runs a
separate hermetic registry publish/install gate with network uplinks disabled.
The static `repository.security-baseline` capability does not manufacture equivalent
evidence for a consumer; each publishing consumer needs its own real packed-
artifact gate until a separate reusable package capability is accepted.

## Permission-sensitive test environments

Run filesystem refusal tests in disposable repositories under a process that
respects file permissions. Linux root with `CAP_DAC_OVERRIDE` can write into a
`0500` directory, so a chmod-based `EACCES` scenario cannot qualify that refusal
under those privileges. Prefer an unprivileged test process. A Linux root test
runner can remove `dac_override` and `dac_read_search` from its capability
bounding set for the test subprocess; verify an actual denied write in a fresh
temporary directory first. Keep production permissions and host Git hooks intact.

An interrupted test runner has no successful aggregate result. Preserve its log
and exact source identity, complete the interrupted file and remaining files,
and rerun only failed scopes when diagnosing environment-specific failures.
Record each resumed command separately; platform skips and partial reruns do not
establish full-suite, supported-platform or release qualification.

## Private combined artifact qualification

`pnpm package:qualification:built` prepares and checks publishable manifests,
then runs the full packed and hermetic-registry consumers sequentially against
one process-local qualified artifact set. The Linux registry wrapper uses it; standalone `package:check:built` and
`registry-install-e2e:built` each produce a fresh set. Windows jobs retain their
independent qualification scopes.

Windows packed qualification uses three fresh groups: `integration` retains
documentation rollback/history, consumer E2E, authority, local mode, agent and
quality-gate reporting; `sdk-growth` retains SDK growth qualification;
`quality-coverage` retains coverage qualification. Registry qualification uses
`npm-docs`, `pnpm-docs` and `foundation`, retaining both documentation profiles
for each package manager and the installed Foundation consumer. All matrix
members remain required by `windows-check`; default local commands and the
Linux qualification paths still execute the full consumer inventory.

Darwin uses three closed paired profiles: `foundation` runs packed `integration`
then registry `foundation`; `npm-docs` runs packed `sdk-growth` then registry
`npm-docs`; `pnpm-docs` runs packed `quality-coverage` then registry `pnpm-docs`.
Each profile produces its own complete six-package A/B set and consumes it in the
same guarded packed-before-registry lifetime. Their union retains every original
consumer phase exactly once. The fail-closed required `macos-qualification`
aggregate includes every profile and the separate native controls, QGR lifecycle,
repository mutation, scaffolding and document-writing job. No archive authority
crosses jobs. Zero-argument local qualification retains its complete sequence.

Linux registry qualification starts directly after Dependency Review; its
independent fresh consumer does not depend on the repository static check. Other
package and Windows registry jobs wait for their platform's short static job.
Each qualification still
runs its own fresh installation and complete required consumer scope.
Windows consumer groups have a 50-minute bound, preserving the existing release
attester's maximum CI path when combined with the 15-minute static gate.

Each fresh production prepares at most two independent package targets at once.
Their staging trees are separate, both clean builds remain required per target,
and returned records retain catalog order. Failure stops new target admission
and drains every started target before cleanup; no archive authority is shared
between matrix jobs. Every group produces the complete six-package set.

Every target still requires two independent clean builds and the existing
artifact conformance checks. Reuse preserves the producer's retained verified
bytes, exact package membership, names, versions, SHA-256 and SHA-512 integrity.
Physical custody rejects symlink traversal, hardlink aliases, inode replacement,
missing and extra snapshots. It accepts neither caller archive paths nor
serialized or copied handles, and cannot share authority across CI jobs.
Source and toolchain identity is freshly checked before and after production,
at each whole consumer stage boundary, and before final acceptance. Inner phase
checkpoints verify snapshot custody without repeating the entire source walk.
Source drift during packed qualification rejects before registry effects;
drift during registry qualification rejects its final acceptance. No stage may
start after owner completion or failure; admitted child work drains before
cleanup, and consumer or cleanup failures prevent PASS.

This is a private repository qualification mechanism within the existing
artifact boundary, not a public module contract or general reusable runtime.
The deliberate packed rollback mutation uses a separate TEST archive; it never
changes the qualified snapshot passed to the registry consumer.

Clean-stage materialization admits up to four regular-file leaf jobs and drains
all admitted jobs before reporting failure. Directories, symlinks, build order
and each target's independent A/B stages remain serial within their owners;
two package targets can still prepare independently. Stable reads reserve
outstanding bytes before allocation, commit successful bytes synchronously and
release failed reservations. Existing per-state 256 MiB and entry/depth/member
bounds, source identity brackets, external ancestor probes, nearest dependency
resolution, archive equality and downstream custody checks remain enforced.
Ancestor package-name probes are bounded independent I/O, with no cached
absence or source/dependency tree reuse. This private scripts concern introduces
no product module boundary, capability contract or CMS adoption change.
