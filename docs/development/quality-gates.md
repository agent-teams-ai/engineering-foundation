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
| Coverage | `pnpm test:coverage` | Stable native Node coverage qualification with line, branch, and function thresholds |
| Performance | `pnpm test:performance:built` | Advisory 100/1,000/5,000-document timing evidence outside the pull request gate |

`pnpm check` is the deterministic repository and package conformance layer. It
does not claim networked, hosted, or external-tool qualification. `pnpm verify`
is the single local command matching the union of Linux merge lanes: workflow
security, the deterministic check, Buf, hermetic registry installation, published-version
compatibility, dead-code analysis, and parser parity.

Coverage instrumentation runs a stable cross-layer qualification set separately
from process timing, crash, and exhaustive compatibility tests. The normal full
suite remains mandatory; this separation prevents instrumentation overhead from
changing process-timeout semantics while still enforcing production-code
coverage floors.

Required CI executes the same evidence as independent jobs. Linux uses four
checked-in weighted test shards; Windows combines the same manifest into two
sequential shards. Package, registry, published-version, coverage, and static
qualification run in parallel checkouts. The stable required contexts `check`
and `windows-check` are fail-closed aggregators: a failed, cancelled, skipped, or
missing prerequisite fails the required context. Every executable pull request
job depends directly on Dependency Review.

`tests/manifests/test-shards.v1.json` is the closed inventory of top-level test
files. `pnpm test:manifests:check` rejects missing, extra, duplicate, nested,
non-portable, or symlinked entries and rejects missing coverage tests. Add or
rename a test and update the manifest in the same change. Keep
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
