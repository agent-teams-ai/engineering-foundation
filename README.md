# Agent Teams Engineering Foundation

Versioned engineering policy, tooling, and conformance for Agent Teams
repositories.

The [Foundation glossary](docs/reference/glossary.md) defines the core language
used by this repository. In particular, authority is claim-specific, evidence is
bounded to an observation, and qualification must name its subject.

This repository contains reusable development tooling only. Product runtime code
must not import it. Each consumer remains authoritative for its own domain model,
package catalog, dependency permissions, security classifications, and ADRs.

The current integration implements the accepted new-only, independently
versioned portable package boundary. Exact-head artifact qualification,
protected publication, and consumer rollout remain separate gates.
[ADR-0043](docs/decisions/0043-new-only-portable-documentation-package-boundary.md)
is the single authority for the dependency DAG, and the
[delivery contract](docs/development/docs-portable-boundary-delivery.md) records
the evidence still required before release. No compatibility facade or legacy
alias is part of that target.

Consumer-specific document types, schemas, owners, templates, reachability, and
semantic validators remain strict data-only authority in each repository.
Exact public installation and optional MCP pairing have one canonical authority:
the [open-source Docs Protocol workflow](docs/reference/open-source-docs-protocol.md#install-one-exact-version).

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
Oxc adapter. This monorepo uses schema v2 with the explicit `packages` package
root, while the published v1 contract remains loadable for existing consumers. See
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

Any repository can preview a portable documentation setup without mutation:

```bash
docs-protocol init --project-id example/widgets \
  --owner documentation/team --dry-run --json
```

After applying the reviewed digest, `docs.config.yaml` is discovered
automatically. Search and bounded context remain disposable projections:

```bash
docs-protocol find "tenant isolation" --fuzzy
docs-protocol context "tenant isolation" --fuzzy --max-documents 12
docs-protocol check
```

Governed document authoring uses the installed Docs Protocol CLI. `owner` and
`summary` are explicit Intent authority and never receive Foundation defaults:

```bash
agent-teams-docs find "tenant isolation"
agent-teams-docs new --type adr --id ADR-0083 \
  --title "Tenant isolation" --owner architecture/tooling \
  --summary "Defines the tenant-isolation boundary and its verification evidence." \
  --dry-run
agent-teams-docs doctor
agent-teams-docs recover
agent-teams-docs-managed upgrade --to docs-YYYY-MM-DD-N --target-generation 2 --json
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
