# Agent Teams Engineering Foundation

Versioned engineering policy, tooling, and conformance for Agent Teams
repositories.

This repository contains reusable development tooling only. Product runtime code
must not import it. Each consumer remains authoritative for its own domain model,
package catalog, dependency permissions, security classifications, and ADRs.

## Scope

- strict data-only consumer configuration and versioned schemas;
- executable workspace declaration and source dependency policies;
- governed inline suppressions and released public API compatibility;
- repository workflow, SBOM, provenance, and package-content security policy;
- shared Oxlint and TypeScript 7 baseline presets;
- explicit registry and local-link modes;
- deterministic attach, status, detach, and registry assertions;
- closed deterministic `Intent -> Plan -> Apply -> Receipt` scaffolding;
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
pnpm check:fast
pnpm check
pnpm package:check
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

`foundation:check` emits one deterministic aggregate report and enforces every
declared capability. See [consumer adoption](docs/development/consumer-adoption.md).

`foundation:assert-dev-only` rejects runtime dependency placement.
`foundation:assert-registry` additionally proves that the exact declared version
has a matching pnpm lockfile importer, npm package entry, sha512 integrity, and
snapshot without links, source URLs, overrides, or patches. The root and
installed pnpm virtual-store lockfiles must agree, so a stale local installation
cannot be hidden by editing only the repository lockfile.

The scaffolding kernel exposes strict schemas and a journaled filesystem adapter.
Its current built-in recipe is a testing-only conformance fixture; consumer
business packages and feature slices are not generated until separately proven
definitions are released. See the
[scaffolding protocol](docs/architecture/scaffolding-compiler-protocol.md).

See [ownership](docs/architecture/ownership.md),
[consistency evidence gate](docs/architecture/consistency-evidence-gate.md),
[governance capability acceptance review](docs/research/governance-capability-acceptance-review.md),
[local development](docs/development/local-mode.md), and
[release procedure](docs/release.md). The complete documentation index is
[docs/README.md](docs/README.md).
