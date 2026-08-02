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

## Upgrade procedure

1. The consumer repository's configured dependency updater opens an exact-version
   update pull request. Foundation does not prescribe a specific updater.
2. CI installs from the registry and runs all foundation and consumer checks.
3. Breaking schema changes include a migration guide and preserve old immutable
   schemas for the documented migration window.
4. A local foundation checkout may be attached for development, but a PR is not
   mergeable until registry mode is restored and proven.
5. A package update never silently adds a capability declaration or opt-in
   preset; adoption is a separate reviewed change with positive and negative
   parity evidence.

Version 0.2 intentionally removes the executable `foundation.config.mjs`, broad
placeholder capabilities, `enabled: false`, and `projectKind`.
