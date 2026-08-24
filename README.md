# Agent Teams Engineering Foundation

Versioned engineering policy, tooling, and conformance for Agent Teams
repositories.

This repository contains reusable development tooling only. Product runtime code
must not import it. Each consumer remains authoritative for its own domain model,
package catalog, dependency permissions, security classifications, and ADRs.

The monorepo is structured for two one-way layered packages. The Engineering Foundation
owns reusable validation and mutation mechanisms. `@agent-teams/docs-protocol`
depends on Foundation and owns the unified documentation CLI and agent workflow;
Foundation never depends on Docs Protocol. Consumer-specific document types,
schemas, owners, templates, reachability, and semantic validators remain strict
data-only authority in each consumer repository.

## Scope

- strict data-only consumer configuration and versioned schemas;
- executable workspace declaration and source dependency policies;
- governed inline suppressions and released public API compatibility;
- static executable-specification and consumer-gate connectivity;
- repository workflow, SBOM, provenance, and package-content security policy;
- portable agent instructions and changed-file preflight routing;
- opt-in deterministic composition of existing package-script quality gates;
- shared Oxlint and TypeScript 7 baseline presets;
- explicit registry and local-link modes;
- deterministic attach, status, detach, and registry assertions;
- closed deterministic `Intent -> Plan -> Apply -> Receipt` scaffolding;
- governed document catalog, deterministic non-reserving planning, create-only
  publication, and exact-version recovery commands;
- isolated package-content and consumer verification;
- release automation for immutable public npm versions.

Capabilities are extracted incrementally from proven repositories. A capability
moves here only with parity fixtures and a consumer conformance test.
`workspace.dependency-declarations` is active.
`architecture.source-dependencies` is active and dogfooded with its accepted
Oxc adapter. See
[Executable capabilities](docs/architecture/executable-capabilities.md) and
[the parser spike](docs/research/source-dependency-parser-spike.md).
Suppression governance, released public API compatibility, and the publishing-
repository security baseline are accepted, implemented, released, and
dogfooded. Consumers still enable each capability explicitly and must satisfy
their consumer-owned adoption gates; installing a package version does not
activate policy.

## Commands

```bash
pnpm install
pnpm check:changed
pnpm check:fast
pnpm check
pnpm verify
pnpm package:check
pnpm quality:gate:fast
pnpm foundation:qualification
```

Consumers use:

```bash
pnpm foundation:check
pnpm foundation:attach -- /absolute/path/to/engineering-foundation
pnpm foundation:status
pnpm foundation:detach
pnpm foundation:assert-dev-only
pnpm foundation:assert-registry
```

Governed documentation uses the installed Docs Protocol CLI. `owner` and `summary` are
explicit Intent authority and never receive Foundation defaults:

```bash
agent-teams-docs find "tenant isolation"
agent-teams-docs new --type adr --id ADR-0083 \
  --title "Tenant isolation" --owner architecture/tooling \
  --summary "Defines the tenant-isolation boundary and its verification evidence." \
  --dry-run
agent-teams-docs doctor
agent-teams-docs recover
```

After reviewing a dry run, repeat `agent-teams-docs new` with `--apply`, follow its
exact reachability instruction, and run the consumer's standard repository
check. See the
[document authoring protocol](docs/architecture/document-authoring-protocol.md#canonical-agent-and-operator-cli)
for the complete CLI and JSON contract.

`foundation:check` emits one deterministic aggregate report and enforces every
declared capability. See [consumer adoption](docs/development/consumer-adoption.md).
This repository makes its source lifecycle explicit as `foundation:bootstrap`,
`foundation:dogfood`, and `foundation:qualification`; see
[quality gates](docs/development/quality-gates.md#feedback-layers).
The optional `repository.agent-workflow` capability keeps `AGENTS.md` canonical
across coding agents and routes `check:changed` through the shared Foundation
implementation; required CI still runs the complete `verify` evidence as
independent fail-closed lanes. Its read-only `agent-workflow instructions`
command explains the effective `AGENTS.md` chain for a selected repository file.

`foundation:assert-dev-only` rejects runtime dependency placement.
`foundation:assert-registry` additionally proves that the exact declared version
has a matching pnpm lockfile importer, npm package entry, sha512 integrity, and
snapshot without links, source URLs, overrides, or patches. The root and
installed pnpm virtual-store lockfiles must agree, so a stale local installation
cannot be hidden by editing only the repository lockfile.

The scaffolding kernel exposes strict schemas and a journaled filesystem adapter.
It includes a testing-only conformance fixture and one generic private Node
TypeScript library-boundary recipe. The latter creates only the package envelope;
consumer business packages, roles, owner documents, and feature slices remain
consumer-owned. See the [recipe reference](docs/reference/node-typescript-library-boundary.md)
and [scaffolding protocol](docs/architecture/scaffolding-compiler-protocol.md).

See [ownership](docs/architecture/ownership.md),
[consistency evidence gate](docs/architecture/consistency-evidence-gate.md),
[governance capability acceptance review](docs/research/governance-capability-acceptance-review.md),
[local development](docs/development/local-mode.md), and
[release procedure](docs/release.md). The complete documentation index is
[docs/README.md](docs/README.md).
