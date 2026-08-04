# @agent-teams/engineering-foundation

Development-only engineering foundation for Agent Teams repositories.

The package exposes strict YAML configuration, deterministic policy checks,
shared compiler/linter presets, and explicit local versus registry lifecycle
tooling. It is not a production runtime dependency.

It also exposes a closed deterministic scaffolding kernel through
`@agent-teams/engineering-foundation/scaffolding`. Consumers provide strict
data-only Intent, Composition, target-catalog, and owner-document files. The
catalog binds each target to its owner document, and Foundation independently
verifies the allowed owner status before planning, applying, or recovering.
Consumers cannot provide templates, hooks, callbacks, commands, or definition
plugins.

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

Capability presence means enabled. Source architecture, documentation, ADR,
contract-evolution, suppression, public API, and repository-security checks are
adopted independently with consumer-owned policy and qualification evidence.
Installing or upgrading this package never enables them automatically.

Repositories may also declare `repository.agent-workflow` and expose
`agent-teams-foundation agent-workflow changed`. Foundation then discovers the
current Git delta and invokes the consumer's configured pnpm scripts. This local
preflight is portable across agents and never replaces the complete CI gate.

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

Property suites may import deterministic seed and replay helpers from the package
root while keeping `fast-check` in the consumer's development dependencies.

Scaffolding commands use an immutable content-addressed Plan:

```bash
agent-teams-foundation scaffold-plan intents/example.yaml --consumer /repo --json
agent-teams-foundation scaffold-apply plans/example.json --consumer /repo --json
agent-teams-foundation scaffold-recover --consumer /repo --json
```

The current built-in Composition is a testing-only conformance fixture. Product
package and feature recipes, structured updates, and Nx integration require
separate qualification before they become available.
