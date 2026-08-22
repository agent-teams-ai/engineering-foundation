# Engineering Foundation Architecture Audit

Status: independent read-only audit completed on 2026-08-23.

Audited revision:
`36d905362955255c3faed930b11a1e6f05a87ee9` (`origin/main` after PR #168).

The audit evaluates the repository as a long-lived foundation for multiple
projects. It focuses on Clean Architecture, SOLID, DDD bounded contexts,
capability modularity, dependency direction, public API, self-hosting, and the
cost of adding future capabilities. No agent runtime, provisioning, or consumer
project flow was executed.

This was a static source, manifest, policy, contract, documentation, and test
review at the pinned revision. Existing tests were inspected as evidence but not
re-executed as part of the audit. Source line references below refer to that
revision. Scores are unweighted, and the overall score is their arithmetic mean
rounded to one decimal. P0 means a present correctness, safety, or release
invariant failure; P1 means an accepted boundary is already violated or a
safety-critical change surface needs containment; P2 means bounded structural
debt without a demonstrated current invariant failure.

## Verdict

The architecture is stronger than average. Its package direction, data-only
consumer authority, deterministic evidence, recovery model, and release
qualification are deliberately designed and well tested. It is not yet a
9/10 growth-ready foundation: implementation has drifted from the accepted Docs
Protocol boundaries, two documentation orchestration paths remain active, and
safety-critical recovery logic has become cognitively dangerous to change.

**Overall score: 6.2/10. No P0 issue was found; three P1 issues require scoped
containment, not a repository-wide feature freeze.**

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
direction in
[`tests/package-boundary.test.mjs:72-173`](../../tests/package-boundary.test.mjs).

## P1 findings

### 1. Consumer integration is accepted as a bounded context but is not protected as one

The source policy models all Docs Protocol source as one flat
`docs-protocol.package` boundary in
[`architecture/foundation/source-dependencies.yaml:5-32`](../../architecture/foundation/source-dependencies.yaml).
It therefore cannot detect invalid dependencies between domain, application,
adapters, and composition.

The drift is already visible:

- the consumer-integration application use case imports concrete adapters in
  [`plan-consumer-integration.ts:1-35`](../../packages/docs-protocol/src/consumer-integration/application/use-cases/plan-consumer-integration.ts);
- consumer-integration application policies depend on daily Docs Protocol
  domain objects in
  [`consumer-integration-assets.ts:1-10`](../../packages/docs-protocol/src/consumer-integration/application/policies/consumer-integration-assets.ts);
- the accepted managed-integration architecture requires a separate bounded
  context with its own model, use cases, ports, adapters, and composition in
  [`ADR-0031:30-32`](../decisions/0031-managed-docs-consumer-integration.md),
  but the current source tree has no consumer-integration application port.

This is a Dependency Inversion violation and makes future cycles easier to
introduce unnoticed.

### 2. Foundation and Docs Protocol both own documentation orchestration

The active ownership split says Foundation owns mutation mechanisms while Docs
Protocol owns orchestration, query semantics, diagnostics, and command
vocabulary
([`ADR-0026:31-52`](../decisions/0026-retain-only-document-directory-materialization.md)).
The implementation still has two operational paths:

- Foundation imports, advertises, and dispatches its legacy documentation
  commands through
  [`cli.ts:16-17,114-130`](../../packages/engineering-foundation/src/cli.ts),
  [`document-command.ts:90-158`](../../packages/engineering-foundation/src/document-command.ts),
  and its
  [`published package README:49-91`](../../packages/engineering-foundation/README.md);
- Docs Protocol exposes another complete command composition through
  [`packages/docs-protocol/src/composition/cli.ts:196-293,406-440`](../../packages/docs-protocol/src/composition/cli.ts).

If compatibility still requires the Foundation path, it needs an explicit
frozen boundary and sunset policy. Without that, responsibilities and behavior
can drift while both paths continue to look authoritative.

### 3. Safety-critical recovery code is cognitively unsafe to extend

The known-file recovery adapter has 1,334 lines:
[`node-known-file-transaction-recovery.ts`](../../packages/engineering-foundation/src/repository-mutation/adapters/node/node-known-file-transaction-recovery.ts).
Its largest functions mix transition evaluation, durable evidence mutation,
filesystem effects, and orchestration. The apply adapter has 869 lines
([`node-known-file-transaction.ts`](../../packages/engineering-foundation/src/repository-mutation/adapters/node/node-known-file-transaction.ts)),
and the 688-line consumer-integration planner has the same pressure
([`plan-consumer-integration.ts`](../../packages/docs-protocol/src/consumer-integration/application/use-cases/plan-consumer-integration.ts)).

Four current complexity waivers are recorded in
[`suppression-governance.yaml:1-46`](../../architecture/foundation/suppression-governance.yaml),
but its governed root covers only Foundation source. Docs Protocol has five
ungoverned suppressions, including blanket `max-lines` disables in the planner
above and
[`node-consumer-integration-repository.ts:1`](../../packages/docs-protocol/src/consumer-integration/adapters/node-consumer-integration-repository.ts).

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
introducing runtime discovery or plugins. The duplicated registry lists are
visible in
[`capability-registry.ts:1-33`](../../packages/engineering-foundation/src/composition/capability-registry.ts)
and
[`rule-registry.ts:1-39`](../../packages/engineering-foundation/src/composition/rule-registry.ts).

### Public API exposes implementation and qualification seams

The mutation API exports concrete Node functions and fault injectors, while the
document API and Docs Protocol consumer-integration surface expose concrete Node
adapters. Compatibility baselines correctly protect consumers, but they also
make later cleanup expensive. Test and fault seams should move to explicit
qualification entrypoints when consumer evidence permits it. Current examples
are
[`mutation/index.ts:17-28`](../../packages/engineering-foundation/src/mutation/index.ts)
and
[`document-authoring/index.ts:119-127`](../../packages/engineering-foundation/src/document-authoring/index.ts),
and
[`consumer-integration/index.ts:11-26`](../../packages/docs-protocol/src/consumer-integration/index.ts).

### Contract folders mix contract, I/O, mapping, and validation

Several capability `contract/config.ts` files read YAML, call the schema
catalog, normalize policy, and validate it. These are inbound adapters and
mappers rather than pure contracts. Naming and placement should reflect those
responsibilities. Examples include
[`source-dependencies/contract/config.ts:1-8,177-213`](../../packages/engineering-foundation/src/capabilities/source-dependencies/contract/config.ts)
and
[`contract-json-schema-releases/contract/config.ts:147-210`](../../packages/engineering-foundation/src/capabilities/contract-json-schema-releases/contract/config.ts).

### Dependency injection is inconsistent

Some capability factories accept ports, while others construct all concrete
Node adapters internally. Production defaults are useful, but a consistent
injectable factory plus `createDefault...()` composition would improve tests
without turning Foundation into a plugin system. Compare
[`contract-json-schema-releases/module.ts:41-44`](../../packages/engineering-foundation/src/capabilities/contract-json-schema-releases/module.ts)
with
[`source-dependencies/module.ts:21-26`](../../packages/engineering-foundation/src/capabilities/source-dependencies/module.ts).

### Unexpected error diagnostics lose useful classification

The check runner and several capability modules replace unexpected failures
with generic errors. Diagnostics should retain a safe bounded cause class and
phase without exposing absolute paths, repository content, or secrets; see
[`check-runner.ts:19-43`](../../packages/engineering-foundation/src/check-runner.ts).

### Coverage does not reflect the price of recovery defects

The current global floors are 36% lines, 67% branches, and 42% functions
([`run-test-coverage.mjs:5-18`](../../scripts/run-test-coverage.mjs)). The test
suite is broad, but these floors do not protect safety-critical mutation and
recovery modules. The separately recommended partitioned evidence protocol is
research, not an accepted decision
([`deepseek-harness-tooling-comparison.md:1-4,50-60`](deepseek-harness-tooling-comparison.md));
if adopted, it should be followed by module-specific floors for those
boundaries.

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
own npm package, and Docs Protocol depends only downward on Foundation. The root
build invokes the compiler directly before current-source checks
([`package.json:15-26`](../../package.json)), and the Docs Protocol TypeScript
project references Foundation only in the allowed direction
([`packages/docs-protocol/tsconfig.json:23-24`](../../packages/docs-protocol/tsconfig.json)).

```text
Ring 0: package-manager, compiler, and project-reference bootstrap
  -> Ring 1: build current Foundation source
    -> Ring 2: current-source dogfood checks
      -> Ring 3: packed/registry tests and previous-release compatibility
```

The build and minimum dependency-direction guard must remain independent of the
Foundation runtime. The richer package-boundary test imports the freshly built
capability and therefore belongs after Ring 1
([`tests/package-boundary.test.mjs:8,134-173`](../../tests/package-boundary.test.mjs)).
For current-source bootstrapping, a previous release is a compatibility oracle,
not the authority for current source. It remains authoritative for recovery
evidence written by that exact release. Making it the current-source authority
would create a publication chicken-and-egg problem. A separate bootstrap
package is not justified now.

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

These are order-of-magnitude estimates including tests and migration evidence,
not delivery commitments. For MVP sequencing, contain findings 1 and 2 before
adding documentation behavior. Before the next recovery semantic change,
complete the characterization matrix from finding 3, then extract incrementally.
Unrelated capability delivery does not need to wait for the full decomposition,
and P2 work should follow measured change pressure or a second real consumer.

## Options

### 1. Staged repair of the existing two-package modular monolith - recommended

🎯 9/10 🛡️ 9/10 🧠 6/10. Approximately 4,800-9,700 changed lines across focused
pull requests.

This preserves package and wire contracts while bringing implementation back
into alignment with the accepted architecture.

### 2. Minimum containment only

🎯 8/10 🛡️ 6/10 🧠 3/10. Approximately 1,800-3,900 changed lines.

This fixes boundaries, freezes the legacy CLI, and extracts only the worst
recovery hotspot. Registry and public API debt would continue growing.

### 3. Split Foundation into additional kernel and CLI packages

🎯 5/10 🛡️ 8/10 🧠 9/10. Approximately 8,000-15,000 changed lines.

Physical isolation would improve, but the added release, versioning, and
bootstrap complexity is not justified during MVP growth.

## Final recommendation

Keep the existing package graph and self-hosting model. Do not create a new
bootstrap package or a dynamic plugin platform. Before broad capability growth,
make Docs Protocol a real bounded context, retire dual docs orchestration with
consumer evidence, and contain recovery changes behind a characterization
matrix. Decompose recovery incrementally by stable transition responsibilities.
The capability descriptor and partitioned coverage protocol remain supporting
recommendations until separately accepted; neither should block unrelated MVP
delivery.
