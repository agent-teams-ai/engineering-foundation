# @agent-teams/engineering-foundation

Development-only engineering foundation for Agent Teams repositories.

The package exposes strict YAML configuration, deterministic policy checks,
shared compiler/linter presets, and explicit local versus registry lifecycle
tooling. It is not a production runtime dependency.

It also exposes a closed deterministic scaffolding kernel through
`@agent-teams/engineering-foundation/scaffolding`. Consumers provide strict
data-only Intent, Composition, target-catalog, and owner-document files. The
catalog binds each target to one owner document ID. Foundation resolves that ID
from bounded document roots, records the derived path, and independently
verifies the allowed owner status before planning, applying, or recovering.
Consumers cannot provide templates, hooks, callbacks, commands, or definition
plugins.

Document authoring is available through
`@agent-teams/engineering-foundation/document-authoring`. Its catalog and Plan
compiler are read-only; publication and recovery are separate explicit
operations behind the shared Foundation transaction barrier. The catalog
rebuilds a stable snapshot from an explicit data-only profile, consumer metadata
schema, owner map, and Markdown collections. Partial snapshots retain
diagnostics without hiding valid neighboring documents. Document authoring is
not a Foundation capability and never runs as part of `check`.

```ts
import { buildDocumentationCatalog } from
  "@agent-teams/engineering-foundation/document-authoring";

const catalog = await buildDocumentationCatalog({
  consumerRoot: process.cwd(),
  profilePath: "document-authoring.yaml"
});
```

The operator and agent-facing documentation workflow is owned by
`@agent-teams/docs-protocol`. New and migrated consumers expose its commands
through their repository manifest:

```json
{
  "scripts": {
    "docs:info": "agent-teams-docs info",
    "docs:find": "agent-teams-docs find",
    "docs:new": "agent-teams-docs new",
    "docs:doctor": "agent-teams-docs doctor",
    "docs:recover": "agent-teams-docs recover",
    "docs:check": "agent-teams-docs check",
    "check": "agent-teams-foundation repo check"
  }
}
```

```bash
agent-teams-docs find "tenant isolation" --consumer /repo
agent-teams-docs new --type adr --id ADR-0083 \
  --title "Tenant isolation" --owner architecture/tooling \
  --summary "Defines the tenant-isolation boundary and its verification evidence." \
  --dry-run --consumer /repo
agent-teams-docs new --type adr --id ADR-0083 \
  --title "Tenant isolation" --owner architecture/tooling \
  --summary "Defines the tenant-isolation boundary and its verification evidence." \
  --apply --consumer /repo
agent-teams-docs check --consumer /repo
```

Foundation's legacy `docs` CLI namespace remains executable only as a frozen
compatibility surface. Human invocations emit the stable diagnostic code
`FOUNDATION_DOCS_CLI_DEPRECATED`; JSON invocations retain their published
stdout, stderr, envelope, and exit-code contract. The legacy namespace must not
receive new commands, options, orchestration behavior, or Docs Protocol imports.
Removal requires the evidence defined by
[ADR-0033](../../docs/decisions/0033-freeze-legacy-foundation-docs-cli.md).
The canonical current workflow and JSON contract are in the
[document authoring protocol](../../docs/architecture/document-authoring-protocol.md#canonical-agent-and-operator-cli).

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

`quality.executable-specifications` optionally validates a consumer-owned JSON
catalog connecting schemas, documents, generated types, ownership evidence, and
independent consumer gate scripts. It never runs those scripts or imports
consumer state models.

Repositories may also declare `repository.agent-workflow` and expose
`agent-teams-foundation agent-workflow changed`. Foundation then discovers the
current Git delta and invokes the consumer's configured pnpm scripts. This local
preflight is portable across agents and never replaces the complete CI gate.
`agent-teams-foundation agent-workflow instructions <repository-file>` reports
the applicable instruction scopes, precedence, shadowing, byte budget, and
digests without printing or injecting instruction content.

Repositories may independently declare `quality.gate-runner` and run
`agent-teams-foundation gate run <profile>`. A profile is a validated DAG of
existing root package scripts with bounded concurrency, optional task deadlines,
and explicit `needs` versus `after` semantics. Configuration cannot supply
commands or plugins, static `check` never executes scripts, and installation or
upgrade never activates a profile. See the
[quality gate runner reference](../../docs/reference/quality-gate-runner.md).

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

### Recoverable known-file transactions

The `@agent-teams/repository-mutation` package exports the closed
`agent-teams.repository-mutation.known-file/v1` protocol. It can create an absent file or
replace a regular file only when its bytes and mode match an accepted exact
preimage. A shared Foundation barrier, versioned journal, repeated CAS checks,
strict directory durability, conditional rollback, and exact-build recovery
make a serialized multi-file update recoverable without claiming impossible
cross-file atomicity. Unknown content, aliases, symlinks, hard links, path
collisions, and unsupported Windows durability fail closed. Foundation retains
its local-mode admission and domain error mapping while holding the same leaf
lease; the old Foundation mutation facade is not retained.

Every command that accepts `--json` or `--format json` returns one JSON value on
success and failure. Generic command failures use
`foundation-command-error/v1`; document commands keep their command-specific
envelopes.

Property suites may import deterministic seed and replay helpers from the package
root while keeping `fast-check` in the consumer's development dependencies.

Scaffolding commands use an immutable content-addressed Plan:

```bash
agent-teams-foundation scaffold-plan intents/example.yaml --consumer /repo --json
agent-teams-foundation scaffold-apply plans/example.json --consumer /repo --json
agent-teams-foundation scaffold-recover --consumer /repo --json
```

Programmatic callers may bind mutation to expected consumer descriptors with
`recoverFilesystemScaffold(consumerRoot, { projectId, configPath,
targetCatalogPath, compositionId })`. Foundation snapshots the immutable v1
value, validates paths against the published v1 schema exactly, and requires
exact string agreement with the stored journal before reading authority or
continuing recovery. The one-argument API and CLI are unchanged;
`inspectFoundationTransactionAwareMode` remains the read-only advisory preflight.

The current built-in Composition is a testing-only conformance fixture. Product
package and feature recipes, structured updates, and Nx integration require
separate qualification before they become available.
