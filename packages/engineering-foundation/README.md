# @agent-teams/engineering-foundation

Development-only engineering foundation for Agent Teams repositories.

The package exposes strict YAML configuration, deterministic policy checks,
shared compiler/linter presets, and explicit local versus registry lifecycle
tooling. It is not a production runtime dependency.

Consumer CI should run both policy gates:

```bash
agent-teams-foundation check
agent-teams-foundation assert-dev-only
agent-teams-foundation assert-registry
```

Local attach accepts only a built target whose versioned local-mode protocol,
exports, runtime dependencies, and real CLI self-check agree with its package
metadata.

```yaml
schemaVersion: 1
project:
  id: consumer-repository
capabilities:
  workspace.dependency-declarations:
    configPath: architecture/foundation/dependency-declarations.yaml
```

Capability presence means enabled. Add source dependencies, suppression
governance, public API compatibility, or the publishing-repository security
profile only in separate reviewed adoption changes with consumer-owned policy
and qualification evidence. Installing or upgrading this package never enables
them automatically.

The root file is `foundation.config.yaml`. Use
`agent-teams-foundation schema foundation-config/v1` for its canonical schema
and `agent-teams-foundation explain <rule-id>` for rule guidance.

TypeScript consumers may extend
`@agent-teams/engineering-foundation/presets/typescript/node.json`. Oxlint JSON
configuration extends the fast
`./node_modules/@agent-teams/engineering-foundation/presets/oxlint/node.json`
or type-aware `type-aware.json` preset. TypeScript remains the separate typecheck
authority.

`agent-teams-foundation public-api-promote-release` is reserved for the
Changesets version workflow. Normal feature checks never update released API
baselines. Publishing consumers must also enforce release-owned baseline
mutation in required pull-request CI.
