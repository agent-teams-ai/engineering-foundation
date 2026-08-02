# Quality Gates

Status: Active on this repository; reusable presets ship with the next package
release.

## Feedback layers

The checks are intentionally layered so agents get fast feedback without
weakening the merge gate.

| Layer | Command | Purpose |
| --- | --- | --- |
| Fast | `pnpm check:fast` | Oxlint syntax/correctness plus pinned TypeScript 7 |
| Architecture | `pnpm foundation:check` | All declared deterministic capabilities, including docs and ADR governance |
| Workflow security | `pnpm security:workflows` | Pinned Actionlint and Zizmor qualification for all workflows and local actions |
| Patterns | `pnpm architecture:patterns` | Consumer-owned deterministic AST prohibitions |
| Dead code | `pnpm dead-code:check` | Unused files, exports, types, and dependencies |
| Full | `pnpm check` | Complete deterministic package and consumer conformance |

Knip is blocking in the Linux CI job but is not repeated by Windows or the fast
local loop. Nx supplies project discovery, affected builds, and caching; it does
not define architecture policy. Ast-grep owns narrow syntax patterns such as
ambient clock, environment, randomness, and timer access. The foundation source
dependency capability is the only authority for package and architecture edges.
Actionlint and zizmor are independent external gates installed through Aqua with
committed cross-platform checksums. They run only after the Linux job installs
the pinned Node version. Actionlint discovers all workflow YAML files without a
shell glob; Zizmor scans the repository root with strict collection, including
local composite actions outside `.github`. Dependency Review runs inside the
existing required Linux `check` job, so it cannot become an optional parallel
status. CodeQL runs as a separate hosted analysis; none of these tools execute
inside a normal capability check.

## Lint contract

Oxlint is the only JavaScript/TypeScript linter until a concrete missing rule
proves that ESLint is required. The published presets enable correctness,
suspicious, import, promise, Node, Unicorn, Oxc, and type-aware TypeScript rules.

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

Schema v2 additionally requires explicit target entrypoints and rejects runtime
or type-only dependency cycles between packages and architecture boundaries.

Suppression waivers, released API baselines, privileged workflow jobs, and
publishable packages are also closed-world evidence. Existing API baselines are
release-owned and cannot change in a normal pull request.

## Conformance

The test suite includes positive and negative capability fixtures, real lint
failures, local attach/detach recovery, parser parity, ast-grep rule tests, and a
packed-tarball consumer. The tarball consumer installs its own exact Oxlint,
oxlint-tsgolint, and TypeScript versions and proves the published type-aware
preset, source graph v2, documentation links and anchors, idempotent ADR baseline
promotion, and both contract-evolution capabilities.
The tarball is extracted and searched for a source-owned secret canary. Linux CI
also emits an SPDX JSON SBOM and runs Dependency Review inside its required
`check` job.

That tarball check qualifies this repository's published package. The static
`repository.security-baseline` capability does not manufacture equivalent
evidence for a consumer; each publishing consumer needs its own real packed-
artifact gate until a separate reusable package capability is accepted.
