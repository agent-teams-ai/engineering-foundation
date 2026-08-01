# Consumer Adoption

Status: Active for foundation version 0.2.

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

Presets define reusable language correctness only. Feature boundaries, source
roots, exceptions, browser rules, and business architecture remain local.

## Upgrade procedure

1. Renovate opens an exact-version update PR.
2. CI installs from the registry and runs all foundation and consumer checks.
3. Breaking schema changes include a migration guide and preserve old immutable
   schemas for the documented migration window.
4. A local foundation checkout may be attached for development, but a PR is not
   mergeable until registry mode is restored and proven.

Version 0.2 intentionally removes the executable `foundation.config.mjs`, broad
placeholder capabilities, `enabled: false`, and `projectKind`.
