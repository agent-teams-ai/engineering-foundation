# Quality Gates

Status: Active on this repository; reusable presets ship in the current published
package.

## Feedback layers

The checks are intentionally layered so agents get fast feedback without
weakening the merge gate.

| Layer | Command | Purpose |
| --- | --- | --- |
| Changed | `pnpm check:changed` | Foundation-routed checks for the current Git delta |
| Fast | `pnpm check:fast` | Fail-closed test manifests, Oxlint syntax/correctness, and pinned TypeScript 7 |
| Architecture | `pnpm foundation:check` | All declared deterministic capabilities, including docs and ADR governance |
| Workflow security | `pnpm security:workflows` | Pinned Actionlint and Zizmor qualification for all workflows and local actions |
| Buf qualification E2E | `pnpm buf-qualification:e2e` | Real pinned Buf `FILE` compatible, breaking and fabricated-evidence scenarios |
| Patterns | `pnpm architecture:patterns` | Consumer-owned deterministic AST prohibitions |
| Dead code | `pnpm dead-code:check` | Unused files, exports, types, and dependencies |
| Full | `pnpm check` | Complete deterministic package and consumer conformance with coverage thresholds |
| Merge-ready | `pnpm verify` | Local sequential equivalent of all required Linux evidence |
| Coverage | `pnpm test:coverage` | Local native Node coverage qualification with line, branch, and function thresholds |
| Partitioned coverage | `pnpm test:coverage:evidence:built -- --input <artifacts> --head-sha <sha>` | Blocking CI qualification of exact-head raw V8 evidence from the four isolated Linux test shards |
| Performance | `pnpm test:performance:built` | Advisory 100/1,000/5,000-document timing evidence outside the pull request gate |

Foundation's self-dogfood lifecycle is explicit and ordered:

1. `pnpm foundation:bootstrap` builds current workspace source with the pinned
   compiler and package manager, without invoking the Foundation CLI.
2. `pnpm foundation:dogfood` runs the freshly built Foundation CLI against this
   repository. Existing CI jobs may use `foundation:check:built` only after their
   preceding build step succeeds.
3. `pnpm foundation:qualification` first repeats that source dogfood, then checks
   packed and hermetic-registry artifacts and finally runs the pinned published-
   version compatibility oracle. Published versions never govern current-source
   checking.

The private root may link Foundation with `workspace:*` for tool resolution. The
published Foundation manifest cannot depend on itself, Foundation source cannot
depend on Docs Protocol, and no bootstrap package or published dependency cycle
is part of this lifecycle.

`pnpm check` is the deterministic repository and package conformance layer. It
does not claim networked, hosted, or external-tool qualification. `pnpm verify`
is the single local command matching the union of Linux merge lanes: workflow
security, the deterministic check, Buf, hermetic registry installation, published-version
compatibility, dead-code analysis, and parser parity.

Partitioned c8 coverage is the blocking Linux CI coverage authority. Each
existing Linux test shard writes raw V8 coverage without rerunning its tests. Its
sidecar binds the full Git SHA, exact Node and c8 versions, coverage-config
digest, test-manifest digest, shard identity, test list, and every raw-file
digest. The aggregator accepts exactly one artifact for each of shards 1 through
4, rejects missing, unexpected, mixed, duplicate-claim, or modified evidence,
retains the exact bounded bytes it validated, merges once, and applies the
separate c8 floors of 70% lines, 77% branches, and 78% functions. The promoted
floors are below the observed exact-head CI result of 71.88%, 78.97%, and 79.86%
respectively. `c8` is used only for merge/report because the Node test runner can
emit raw V8 JSON but cannot consume coverage from completed processes.

The evidence merger owns `c8` as a pinned CLI-only dependency, so Knip excludes
that dependency from import-based usage detection. Its process-tree fixture is
an explicit Knip entry because Node launches it directly rather than importing
it from the test module.

The shard's test result, all four artifact uploads, evidence aggregation, and the
stable `linux-coverage` context are fail-closed. An evidence setup or sidecar
finalization failure may preserve the original shard test result, but the
required upload or merger then fails. Raw instrumentation still shares each
shard's test process and its timeout.

The former standalone native Node CI lane and the partitioned-coverage kill
switch are removed. Native Node coverage remains available locally through
`pnpm test:coverage` and remains part of `pnpm check` and `pnpm verify`; its
thresholds stay separate because Node and c8 calculate the measured universe
differently.

Required CI executes the same evidence as independent jobs. Linux uses four
checked-in weighted test shards; Windows combines the same manifest into two
sequential shards. Package, registry, published-version, coverage, and static
qualification run in parallel checkouts. The stable required contexts `check`
and `windows-check` are fail-closed aggregators: a failed, cancelled, skipped, or
missing prerequisite fails the required context. Every executable pull request
job depends directly on Dependency Review.

CI concurrency is separated by event type and pull request or ref identity.
Normal updates still cancel stale runs for the same pull request, while an
exact-head release-attester dispatch cannot cancel the pull request run and leave
failed required CheckRuns behind. For generated release pull requests, the
attester prefers the single exact attempt-1 PR run and dispatches a second suite
only when no such run appears during its bounded selection window.

Draft pull-request pushes create no heavy CI or CodeQL work. The cheap,
unconditional security lane still runs pinned Dependency Review and emits the
repository SBOM for every pull-request update; every executable heavy job
depends directly on that lane and additionally requires a non-draft pull
request. `ready_for_review` is an explicit CodeQL trigger, while the ordinary
pull-request trigger starts the full CI graph when an unchanged draft becomes
ready without another push. Every synchronization of a ready pull request takes
the same fail-closed path; there is no elapsed-time admission, artifact reuse
from another SHA, or weaker ready-update route.

Repository protection requires the stable exact-head contexts `CodeQL`,
`analyze`, `check`, `windows-check`, and `macos-qualification`. Independent
hosted-review evidence belongs in pull-request comments; it is not converted
into a workflow-authored or self-attested status check. `ReviewGate` is retired.

`tests/manifests/test-shards.v1.json` owns the cross-platform shards.
`tests/manifests/coverage.v1.json` pins their coverage-only additions, the
merger, production include/exclude boundaries, c8 evidence thresholds, and the
separate legacy Node coverage thresholds and test selection. The two threshold
authorities remain explicit because Node and c8 do not calculate every metric
identically. Together the manifests are the closed inventory of
repository and Docs Protocol test files. `pnpm test:manifests:check` rejects missing, extra,
duplicate, nested, non-portable, or symlinked test entries and malformed
coverage configuration. Add or rename a test and update the shard manifest in
the same change. Each shard's `tests` remain the cross-platform required suite;
the coverage manifest's `additionalTestsByShard` extends only the Linux
raw-evidence run with suites that are already qualified elsewhere but are needed
for the complete coverage universe. Keep
`--test-concurrency=1` inside a shard because recovery tests intentionally share
process and filesystem assumptions.

The scheduled `Performance signals` workflow records benchmark JSON and a Job
Summary, but has no absolute blocking threshold. The separate read-only `CI
feedback` observer reads completed-run metadata from the GitHub API, reports the
slowest lanes, and retains a source-bound JSON artifact for 30 days. It checks
out only the protected default-branch observer code, never pull request code.
Cancelled obsolete runs remain normal: agents should use `check:changed`, then
`check:fast`, and run `verify` once before handoff rather than after every edit.

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
Linux CI separately runs the real Aqua-pinned Buf qualification E2E because the
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
