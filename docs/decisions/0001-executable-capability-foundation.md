# ADR-0001: Executable Capability Foundation

Status: Accepted

Date: 2026-08-01

Decision owner: Product owner

## Context

Version 0.1 established reproducible registry consumption and an explicit local
attach/detach lifecycle. The package configuration reserved broad capability
names, but no capability executed a reusable consumer policy.

The first extraction must not freeze a speculative plugin API, copy the
orchestrator's mixed-purpose topology validator, or make foundation authoritative
for consumer architecture. It must also remain deterministic for CI and usable by
multiple repositories with different business models.

## Decision

1. Replace executable consumer configuration with strict, data-only
   `foundation.config.yaml` before enabling the first executable capability.
2. Enable a capability by declaring its granular identifier. Remove broad
   placeholder capabilities, `enabled: false`, and global `projectKind` policy.
3. Split dependency governance into two capabilities:
   - `workspace.dependency-declarations` validates workspace manifests,
     dependency protocols, catalogs, and version declaration policy;
   - `architecture.source-dependencies` validates observed source imports,
     exports, and consumer-owned dependency edges.
4. Implement `workspace.dependency-declarations` first. It proves the capability
   lifecycle without prematurely selecting a source parser.
5. Keep the capability runner, registry, ports, and normalized intermediate
   models internal. Version 0.2 publishes no plugin or consumer-implemented rule
   API.
6. Publish only data contracts that consumers need: strict configuration
   schemas, CLI behavior, one aggregate report schema, stable rule identifiers,
   and exit-code semantics. The report shape is identical for one or many
   selected capabilities.
   JSON Schema is canonical; generated TypeScript types and validators cannot
   become independent sources of truth.
7. Use a static, closed registry of built-in capabilities. Dynamic discovery,
   npm plugin loading, service location, and arbitrary consumer rule functions are
   prohibited.
8. Foundation owns generic mechanics and rule execution. Each consumer owns
   package identities, paths, roles, allowed relationships, exceptions, and
   project-specific evidence.
9. A complete repository check is the only blocking CI authority in version 0.2.
   Affected execution, caching, watch mode, SARIF, and autofix may optimize later
   versions but cannot weaken the complete check.
10. Migrate a donor rule only after generic adversarial fixtures, normalized
    dual-run parity, package tarball verification, and a consumer E2E test pass.

## Consequences

- Version 0.2 intentionally makes a pre-1.0 breaking configuration change.
- The first capability remains read-only, hermetic, and pnpm-aware through an
  internal package-manager adapter boundary.
- The source parser decision is deferred to an executable spike and cannot alter
  public configuration or report contracts.
- Tactical DDD is not forced onto tooling. Policies, specifications, immutable
  models, and ports are used where they express real complexity; artificial
  aggregates, entities, and repositories are prohibited.

## Rejected alternatives

- Keep the broad `architecture` capability and add unrelated rules to it.
- Copy `validate-package-topology.mjs` as one foundation capability.
- Publish `Capability<T>` as a third-party extension interface in version 0.2.
- Execute JavaScript or TypeScript consumer configuration in CI.
- Treat successful execution against a repository with no materialized product
  packages as sufficient conformance evidence.

The canonical target design is
[Executable capabilities](../architecture/executable-capabilities.md).
