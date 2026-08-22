# Consumer Adoption

Status: Active for the current foundation release.

## Registry baseline

Consumers pin `@agent-teams/engineering-foundation` as an exact
`devDependency`. Production code cannot import it. The normal state uses the
published npm package and a frozen lockfile.

Required scripts:

```json
{
  "foundation:check": "agent-teams-foundation check",
  "foundation:status": "agent-teams-foundation status",
  "foundation:attach": "agent-teams-foundation attach",
  "foundation:detach": "agent-teams-foundation detach",
  "foundation:assert-dev-only": "agent-teams-foundation assert-dev-only",
  "foundation:assert-registry": "agent-teams-foundation assert-registry"
}
```

For portable coding-agent feedback, explicitly adopt
`repository.agent-workflow`, keep `AGENTS.md` canonical, add import/pointer
adapters for supported agents, and expose `check:changed`, `check:fast`, and
`check`. The shared command implementation remains in Foundation; the consumer
keeps only its policy mapping and existing required CI call. See the
[agent workflow reference](../reference/repository-agent-workflow.md).

Blocking CI runs the full check plus registry assertions. Local source work uses
the guarded attach/status/detach lifecycle; manifests and lockfiles keep the
published exact version throughout.

## Configuration

Create `foundation.config.yaml`:

```yaml
schemaVersion: 1
project:
  id: consumer-id
capabilities:
  architecture.source-dependencies:
    configPath: architecture/foundation/source-dependencies.yaml
  workspace.dependency-declarations:
    configPath: architecture/foundation/dependency-declarations.yaml
```

Create the capability-owned configuration:

```yaml
schemaVersion: 1
packageManager:
  kind: pnpm
  workspaceManifest: pnpm-workspace.yaml
policies:
  externalDependencies: catalog
  catalogVersions: exact
  internalDependencies: workspace-protocol
  reservedScopes:
    - "@consumer-scope/"
  developmentOnlyPackages:
    - oxlint
    - typescript
  exactRegistryDevelopmentOnlyPackages:
    - "@agent-teams/engineering-foundation"
```

The consumer owns scope and package identities. Foundation owns validation
semantics. Configuration is strict data: unknown keys, aliases, merge keys,
custom tags, duplicate keys, escaping paths, and executable interpolation are
not accepted.

Declare only capabilities that apply to the repository. Package installation or
upgrade does not enable a capability. Suppression governance requires a
consumer-owned waiver and protected-rule policy. A versioned TypeScript package
may add `package.public-api-compatibility` only after required PR CI protects
existing baselines as release-owned evidence. A publishing tooling repository
may add `repository.security-baseline` with consumer-owned paths, privileged
jobs, release evidence, and a separate real-tarball E2E gate. Non-publishing
repositories do not fabricate package evidence.

Adopt `quality.executable-specifications` only after a real donor specification
exists. The consumer catalog binds its own schemas, documents, ownership
evidence, and independent package scripts. Generated types and their generation
gate are declared together only when the consumer produces them. Required CI
executes the declared property, mutation, optional type-generation, and optional
state-model gates; Foundation only checks their static connectivity and must not
be used as evidence that those scripts succeeded. See the
[executable specification reference](../reference/executable-specifications.md).

Adopt `quality.gate-runner` separately from a package upgrade. Profiles may
reference only existing root package scripts and must define explicit bounded
concurrency and per-task deadlines where a hung gate is a real risk. Run them
with `agent-teams-foundation gate run <profile>` only after the consumer build
has made the installed CLI available. Static `foundation check` validates the
configuration but never runs the scripts. See the
[quality gate runner reference](../reference/quality-gate-runner.md).

## Current contract version policy

Foundation-owned configuration, evidence and protocol contracts currently have
one active identity: `v1`. Before independent production adoption, a breaking
correction updates that sole `v1` shape and all known consumers in one reviewed
release and adoption wave. The current package does not ship parallel legacy
schemas, cross-version compatibility readers or migration routers.

The Public API checker accepts an immutable single-entrypoint `v1` release
baseline and normalizes it to the current multi-entrypoint `v1` comparison
model. This preserves release evidence without creating another schema
identity. New baseline promotion always writes the current `v1` shape.

A Foundation-owned `v2` is allowed only after a new accepted ADR proves a real
non-atomic migration boundary, such as an independently deployed exact-version
consumer or persisted contract instance. The ADR must define migration evidence,
support duration and retirement. Published npm artifacts and accepted ADRs remain
immutable history and are never rewritten.

This policy does not rename versions owned by external tools or standards. Buf
config `version: v2`, SARIF 2.1.0, JSON Schema drafts, package SemVer and action
versions retain their upstream identities and must be labelled as external.

## Shared presets

Node TypeScript projects extend:

```json
{
  "extends": "@agent-teams/engineering-foundation/presets/typescript/node.json"
}
```

Oxlint JSON configuration extends the installed package path and keeps local
ignore patterns or project-specific additions in the consumer:

```json
{
  "extends": [
    "./node_modules/@agent-teams/engineering-foundation/presets/oxlint/node.json"
  ]
}
```

Maintainability budgets are deliberately opt-in. A production source config
adds `presets/oxlint/maintainability.json`; test and fixture lint lanes use
`presets/oxlint/maintainability-tests.json`. The production budgets are 500
effective lines per file, 150 per function, complexity 20, nesting depth 4,
and 5 parameters. The test budgets are 800, 250, 30, 5, and 6 respectively.
Generated and vendored paths are excluded from these five budgets with a local
override; they may remain subject to the consumer's other lint rules. Installing
a new Foundation version never activates either preset automatically.

Presets define reusable language correctness only. Feature boundaries, source
roots, exceptions, browser rules, and business architecture remain local.
Use `type-aware.json` in the complete lint gate and keep TypeScript as a separate
typecheck. The source dependency capability configuration remains consumer-owned:
it declares opaque boundary IDs and allowed edges while package manifests remain
authoritative for package identities, dependencies, and exports.

Source boundaries default to `dependencyMode: runtime`. A boundary containing
only test, specification, generator, or other development tooling may declare
`dependencyMode: development`; this admits runtime imports from that package's
declared `devDependencies` without weakening the boundary package allowlist.
Never classify production runtime source as development to hide a dependency
placement violation.
Keep development boundaries in dedicated workspace packages when runtime source
imports the package by name. Source-dependencies v1 deliberately blocks runtime
and type-only imports into a mixed-mode package because it cannot prove which
boundary owns an exported subpath; development boundaries may still import it
when manifest declarations and allowlists permit the edge.

## Deterministic scaffolding

Scaffolding is opt-in through its own strict
`architecture/foundation/scaffolding.yaml`; it is not a `foundation.config.yaml`
capability and package upgrades never add a Composition automatically. The
consumer owns target identities, paths, roles, owner documents, bounded document
roots, approved Compositions, and project-specific parameter constraints. A
target catalog stores only the owner document ID. Foundation resolves its path
exactly once from the configured roots and binds that path and document digest
into the generated Plan.

Agents must save and review the generated Plan before Apply. Apply rechecks the
consumer authority read set, proves that the closed compiler reproduces the
exact Plan from its embedded normalized Intent and current consumer facts, takes
the repository Foundation operation lock, rejects overwrite and path ambiguity,
and records a recovery journal before the first file is published.
`scaffold-recover` is mandatory after an interrupted transaction. The current
consumer authority must remain available and reproduce the journal Plan exactly;
otherwise recovery leaves the journal and outputs unchanged. The testing Recipe
remains conformance-only. The generic Node TypeScript library Recipe may create a
package boundary only; it must not be treated as a product architecture or DDD
template. See the [recipe reference](../reference/node-typescript-library-boundary.md).
Scaffolding, future document authoring, attach, and detach share one physical
transaction barrier. Unknown, corrupt, temporary-only, or foreign transaction
evidence is never removed automatically. A verified journal created by another
exact Foundation version reports that version as the required recovery route
and blocks package switching until recovery is complete.

### Scaffolding transition from 0.5.0

Version `0.5.0` published the provisional rendering contract before any product
donor was qualified. A consumer must finish every pending `0.5.0`
`scaffold-recover` operation while its dependency and lockfile still pin exactly
`@agent-teams/engineering-foundation@0.5.0`, and verify that the local journal is
absent before upgrading. Saved old-format Plans and Receipts are historical
evidence only and cannot be applied by the canonical source-bound API.

If an upgrade discovers an old-format journal, it fails closed. Restore the
exact `0.5.0` package from the registry, recover or manually resolve that
transaction under its documented rules, remove no journal by hand, then retry
the reviewed upgrade. There is no in-place journal conversion. The immutable
`0.5.0` registry artifact remains the recovery implementation and schema source
for that transition; current packages intentionally expose only the canonical
contract.

## Upgrade procedure

1. The consumer repository's configured dependency updater opens an exact-version
   update pull request. Foundation does not prescribe a specific updater.
2. CI installs from the registry and runs all foundation and consumer checks.
3. Before independent production adoption, breaking Foundation-owned contract
   corrections keep the sole current `v1` and update every known consumer in the
   same coordinated wave. Historical schemas remain available only inside their
   immutable exact registry artifacts. After real independent adoption, a new
   contract version and migration window require the ADR evidence in ADR-0019.
4. A local foundation checkout may be attached for development, but a PR is not
   mergeable until registry mode is restored and proven.
5. A package update never silently adds a capability declaration or opt-in
   preset; adoption is a separate reviewed change with positive and negative
   parity evidence.

Version 0.2 intentionally removes the executable `foundation.config.mjs`, broad
placeholder capabilities, `enabled: false`, and `projectKind`.
