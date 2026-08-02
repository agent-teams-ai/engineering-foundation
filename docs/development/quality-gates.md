# Quality Gates

Status: Active on this repository; reusable presets ship in the current published
package.

## Feedback layers

The checks are intentionally layered so agents get fast feedback without
weakening the merge gate.

| Layer | Command | Purpose |
| --- | --- | --- |
| Fast | `pnpm check:fast` | Oxlint syntax/correctness plus pinned TypeScript 7 |
| Architecture | `pnpm foundation:check` | Dependency, source, suppression, API, and repository-security evidence |
| Patterns | `pnpm architecture:patterns` | Consumer-owned deterministic AST prohibitions |
| Dead code | `pnpm dead-code:check` | Unused files, exports, types, and dependencies |
| Full | `pnpm check` | Complete deterministic package and consumer conformance |

Knip is blocking in the Linux CI job but is not repeated by Windows or the fast
local loop. Nx supplies project discovery, affected builds, and caching; it does
not define architecture policy. Ast-grep owns narrow syntax patterns such as
ambient clock, environment, randomness, and timer access. The foundation source
dependency capability is the only authority for package and architecture edges.

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

Suppression waivers, released API baselines, privileged workflow jobs, and
publishable packages are also closed-world evidence. Existing API baselines are
release-owned and cannot change in a normal pull request.

## Conformance

The test suite includes positive and negative capability fixtures, real lint
failures, local attach/detach recovery, parser parity, ast-grep rule tests, and a
packed-tarball consumer. The tarball consumer installs its own exact Oxlint,
oxlint-tsgolint, and TypeScript versions and proves the published type-aware
preset and both executable capabilities.
The tarball is extracted and searched for a source-owned secret canary. Linux CI
also emits an SPDX JSON SBOM; Dependency Review runs as an independent required
workflow.

That tarball check qualifies this repository's published package. The static
`repository.security-baseline` capability does not manufacture equivalent
evidence for a consumer; each publishing consumer needs its own real packed-
artifact gate until a separate reusable package capability is accepted.
