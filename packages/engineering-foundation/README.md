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

The root file is `foundation.config.yaml`. Use
`agent-teams-foundation schema foundation-config/v1` for its canonical schema
and `agent-teams-foundation explain <rule-id>` for rule guidance.

TypeScript consumers may extend
`@agent-teams/engineering-foundation/presets/typescript/node.json`. Oxlint JSON
configuration extends
`./node_modules/@agent-teams/engineering-foundation/presets/oxlint/node.json`.
