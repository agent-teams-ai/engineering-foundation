# Engineering Foundation Architecture Audit

Status: independent read-only audit completed on 2026-08-23.

Audited revision:
`36d905362955255c3faed930b11a1e6f05a87ee9` (`origin/main` after PR #168).

The audit evaluates the repository as a long-lived foundation for multiple
projects. It focuses on Clean Architecture, SOLID, DDD bounded contexts,
capability modularity, dependency direction, public API, self-hosting, and the
cost of adding future capabilities. No agent runtime, provisioning, or consumer
project flow was executed.

## Verdict

The architecture is stronger than average. Its package direction, data-only
consumer authority, deterministic evidence, recovery model, and release
qualification are deliberately designed and well tested. It is not yet a
9/10 growth-ready foundation: implementation has drifted from the accepted Docs
Protocol boundaries, two documentation orchestration paths remain active, and
safety-critical recovery logic has become cognitively dangerous to change.

**Overall score: 6.6/10. No P0 issue was found; three P1 issues require staged
repair before broad capability growth.**

| Criterion | Score |
| --- | ---: |
| Clean Architecture | 6/10 |
| SOLID | 6/10 |
| DDD and bounded contexts | 6/10 |
| Capability modularity | 7/10 |
| Dependency direction | 8/10 |
| Composition roots | 6/10 |
| Registry design | 6/10 |
| Public API | 6/10 |
| Capability growth readiness | 5/10 |
| Testability | 7/10 |
| Diagnostics | 6/10 |
| Bootstrap and self-hosting | 8/10 |
| Cognitive complexity | 4/10 |

## Architecture map

```text
Private repository composition
  -> Engineering Foundation
       -> capabilities/*
       -> document-authoring kernel
       -> scaffolding
       -> repository-mutation
       -> transaction-coordination
  -> Docs Protocol
       -> Foundation public ports
       -> daily docs application
       -> consumer-integration
```

The package direction is correct: Docs Protocol depends on Foundation, while
Foundation does not import Docs Protocol. Manifest and source tests enforce this
direction in [`tests/package-boundary.test.mjs`](../../tests/package-boundary.test.mjs).

## P1 findings

### 1. Docs Protocol is declared as a bounded context but is not protected as one

The source policy models all Docs Protocol source as one flat
`docs-protocol.package` boundary in
[`architecture/foundation/source-dependencies.yaml`](../../architecture/foundation/source-dependencies.yaml).
It therefore cannot detect invalid dependencies between domain, application,
adapters, and composition.

The drift is already visible:

- the consumer-integration application use case imports concrete adapters in
  [`plan-consumer-integration.ts`](../../packages/docs-protocol/src/consumer-integration/application/use-cases/plan-consumer-integration.ts);
- consumer-integration application policies depend on daily Docs Protocol
  domain objects;
- the accepted managed-integration architecture requires a separate bounded
  context with its own model, use cases, ports, adapters, and composition.

This is a Dependency Inversion violation and makes future cycles easier to
introduce unnoticed.

### 2. Foundation and Docs Protocol both own documentation orchestration

The accepted ownership split says Foundation owns mutation mechanisms while
Docs Protocol owns orchestration, query semantics, diagnostics, and command
vocabulary. The implementation still has two operational paths:

- Foundation imports, advertises, and dispatches its legacy documentation
  commands through
  [`cli.ts`](../../packages/engineering-foundation/src/cli.ts) and
  [`document-command.ts`](../../packages/engineering-foundation/src/document-command.ts);
- Docs Protocol exposes another complete command composition through
  [`packages/docs-protocol/src/composition/cli.ts`](../../packages/docs-protocol/src/composition/cli.ts).

If compatibility still requires the Foundation path, it needs an explicit
frozen boundary and sunset policy. Without that, responsibilities and behavior
can drift while both paths continue to look authoritative.

### 3. Safety-critical recovery code is cognitively unsafe to extend

The known-file recovery adapter has 1,334 lines:
[`node-known-file-transaction-recovery.ts`](../../packages/engineering-foundation/src/repository-mutation/adapters/node/node-known-file-transaction-recovery.ts).
Its largest functions mix transition evaluation, durable evidence mutation,
filesystem effects, and orchestration. The apply adapter has 869 lines and the
same pressure is appearing in Docs Protocol consumer integration.

Four current complexity waivers are recorded in
[`suppression-governance.yaml`](../../architecture/foundation/suppression-governance.yaml),
but that governance covers only Foundation source while Docs Protocol already
uses blanket file-level suppressions.

Explicit recovery states are a strength and must remain unchanged. The problem
is not the number of states; it is that several reasons to change live inside
the same functions and adapters.

## P2 findings

### Static registries are safe but cause change amplification

Adding a capability currently touches the capability registry, rule registry,
root schema, schema catalog, source boundaries, tests, and documentation. The
closed registry is the correct security model, but the multiple synchronized
lists weaken Open/Closed compliance. A single internal static
`CapabilityDescriptor` should derive capability and rule registries without
introducing runtime discovery or plugins.

### Public API exposes implementation and qualification seams

The mutation API exports concrete Node functions and fault injectors, while the
document API and Docs Protocol consumer-integration surface expose concrete Node
adapters. Compatibility baselines correctly protect consumers, but they also
make later cleanup expensive. Test and fault seams should move to explicit
qualification entrypoints when consumer evidence permits it.

### Contract folders mix contract, I/O, mapping, and validation

Several capability `contract/config.ts` files read YAML, call the schema
catalog, normalize policy, and validate it. These are inbound adapters and
mappers rather than pure contracts. Naming and placement should reflect those
responsibilities.

### Dependency injection is inconsistent

Some capability factories accept ports, while others construct all concrete
Node adapters internally. Production defaults are useful, but a consistent
injectable factory plus `createDefault...()` composition would improve tests
without turning Foundation into a plugin system.

### Unexpected error diagnostics lose useful classification

The check runner and several capability modules replace unexpected failures
with generic errors. Diagnostics should retain a safe bounded cause class and
phase without exposing absolute paths, repository content, or secrets.

### Coverage does not reflect the price of recovery defects

The current global floors are 36% lines and 42% functions. The test suite is
broad, but these floors do not protect safety-critical mutation and recovery
modules. The planned partitioned evidence should be followed by module-specific
floors for those boundaries.

## Strengths to preserve

- one-way package dependencies are actively enforced;
- capabilities are mostly separated into model, policies, ports, adapters, and
  composition;
- consumer authority is data-only and no executable plugin surface exists;
- deterministic sorting, bounded schemas, immutable evidence, and exact-build
  recovery are systemic rather than isolated conventions;
- CAS, durable journals, explicit failure states, crash fixtures, and hostile
  filesystem tests provide unusually strong mutation safety;
- public API baselines, Changesets, packed tarball consumers, registry E2E, and
  provenance protect the release boundary;
- independent Foundation capability checks already execute concurrently and
  produce deterministically ordered results.

## Bootstrap and self-hosting decision

Foundation should continue using the current source build as its primary
dogfood runtime. The existing workspace dependency is not a cycle: the private
repository root is a composition host, Foundation source does not import its
own npm package, and Docs Protocol depends only downward on Foundation.

```text
Ring 0: compiler and package-graph guards
  -> Ring 1: build current Foundation source
    -> Ring 2: current-source dogfood checks
      -> Ring 3: packed/registry tests and previous-release compatibility
```

The build and minimum package-graph guards must remain independent of
Foundation. A previous released Foundation version is useful only as a
compatibility oracle in a disposable consumer; making it authoritative for the
current source would create a publication chicken-and-egg problem. A separate
bootstrap package is not justified now.

## Staged remediation plan

1. **Contain Docs Protocol boundaries, 700-1,300 changed lines**
   - model daily docs and consumer integration as explicit boundaries;
   - forbid application-to-adapter imports;
   - include Docs Protocol in suppression governance;
   - add architecture tests for every allowed direction.

2. **Close dual documentation ownership, 600-1,400 changed lines**
   - freeze the legacy Foundation docs CLI;
   - define its compatibility window and removal evidence;
   - move published guidance to the Docs Protocol path;
   - delete the legacy path only after consumer parity.

3. **Decompose recovery without changing wire semantics, 2,000-4,000 changed lines**
   - extract typed transition evaluators, evidence readers, and filesystem
     executors;
   - preserve every journal state, digest, and exact-build recovery rule;
   - capture a complete characterization and crash matrix before extraction.

4. **Reduce capability change amplification, 800-1,500 changed lines**
   - introduce one internal static capability descriptor source;
   - derive capability and rule registries;
   - keep schema and source-boundary drift tests;
   - do not introduce runtime plugins.

5. **Narrow API and strengthen evidence, 700-1,500 changed lines**
   - move fault injection to qualification entrypoints;
   - add recovery-specific coverage floors;
   - retain safe unexpected-error classification.

## Options

### 1. Staged repair of the existing two-package modular monolith - recommended

Confidence 9/10, reliability 9/10, complexity 6/10. Approximately 4,500-8,000
changed lines across focused pull requests.

This preserves package and wire contracts while bringing implementation back
into alignment with the accepted architecture.

### 2. Minimum containment only

Confidence 8/10, reliability 6/10, complexity 3/10. Approximately 1,500-3,000
changed lines.

This fixes boundaries, freezes the legacy CLI, and extracts only the worst
recovery hotspot. Registry and public API debt would continue growing.

### 3. Split Foundation into additional kernel and CLI packages

Confidence 5/10, reliability 8/10, complexity 9/10. Approximately 8,000-15,000
changed lines.

Physical isolation would improve, but the added release, versioning, and
bootstrap complexity is not justified during MVP growth.

## Final recommendation

Keep the existing package graph and self-hosting model. Do not create a new
bootstrap package or a dynamic plugin platform. Before broad capability growth,
make Docs Protocol a real bounded context, retire dual docs orchestration with
consumer evidence, and decompose recovery by stable transition responsibilities.
The capability descriptor and partitioned coverage work already planned are the
correct supporting improvements.
