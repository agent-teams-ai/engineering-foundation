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

Agents can query the same stable catalog without a generated search index. The
v1 query is a normalized, case-independent literal substring over document ID,
title, summary, headings, and body. Filters are exact and combine with AND;
results sort by ID and then repository path.

Node/pnpm consumers expose the short agent-facing commands through their own
repository manifest; Foundation keeps the underlying CLI package-manager
neutral:

```json
{
  "scripts": {
    "docs:find": "agent-teams-foundation docs find",
    "docs:new": "agent-teams-foundation docs new",
    "docs:doctor": "agent-teams-foundation docs doctor",
    "check": "agent-teams-foundation repo check"
  }
}
```

```bash
pnpm docs:find "tenant isolation" --consumer /repo
pnpm docs:find --type adr --status proposed --owner architecture --consumer /repo --json
```

The default profile is
`architecture/foundation/document-authoring.yaml`; `--profile` selects another
repository-relative profile. Zero matches is success. A partial catalog retains
valid matches and structured diagnostics while returning exit code `1`.

Create a governed document with an explicit ID, owner, and summary. Foundation
does not infer `--owner` or `--summary` from the document type, schema, path, or
current user:

```bash
agent-teams-foundation docs new --type adr --id ADR-0083 \
  --title "Tenant isolation" --owner architecture/tooling \
  --summary "Defines the tenant-isolation boundary and its verification evidence." \
  --dry-run --consumer /repo
agent-teams-foundation docs new --type adr --id ADR-0083 \
  --title "Tenant isolation" --owner architecture/tooling \
  --summary "Defines the tenant-isolation boundary and its verification evidence." \
  --consumer /repo
```

`--dry-run` compiles a non-reserving preview and performs no repository
mutation. A successful create reports the document path and either the exact
consumer-authorized index path and Markdown link to add, or the standard
repository check as the next step. Use the read-only doctor before operating on
uncertain transaction state, and run recovery only when it reports an automatic
document recovery route:

```bash
agent-teams-foundation docs doctor --consumer /repo
agent-teams-foundation docs recover --consumer /repo
agent-teams-foundation check --consumer /repo
```

Every docs command accepts `--json`. Search uses command-envelope v1; mutation
commands use command-envelope v2. Machine mode writes exactly one bounded JSON
object to stdout, keeps diagnostics and remediation structured, uses `/` in
repository paths, and omits timestamps and durations. Stable exit codes are
`0` success, `1` conflict or recovery required, `2` invalid input, `3`
execution failure, and `130` cancellation. The canonical details are in the
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

The `@agent-teams/engineering-foundation/mutation` entrypoint exports the closed
`foundation.replace-known-file/v1` protocol. It can create an absent file or
replace a regular file only when its bytes and mode match an accepted exact
preimage. A shared Foundation barrier, versioned journal, repeated CAS checks,
strict directory durability, conditional rollback, and exact-build recovery
make a serialized multi-file update recoverable without claiming impossible
cross-file atomicity. Unknown content, aliases, symlinks, hard links, path
collisions, and unsupported Windows durability fail closed.

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

The current built-in Composition is a testing-only conformance fixture. Product
package and feature recipes, structured updates, and Nx integration require
separate qualification before they become available.
