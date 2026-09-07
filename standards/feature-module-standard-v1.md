# Feature Module Standard v1

Status: Accepted and immutable

Standard ID: `agent-teams.feature-module-standard`

Version: `v1`

Owner: Agent Teams organization maintainers

Published: 2026-08-29

## Purpose

This standard defines a language-neutral architecture for feature-owned
capability slices inside explicitly owned production modules. It separates
business meaning, use-case coordination, external integration, and composition
without requiring one programming language, framework, build system, or
deployment model.

The standard is intentionally independent of repository names, package managers,
directory roots, transport technologies, dependency-injection frameworks, and
conformance implementations. Each adopting repository maps these rules to its
own topology through a local adoption profile.

## Normative language

The terms MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative. Text without
one of those terms explains intent or supplies examples.

Version `v1` is byte-immutable. Corrections or changed requirements are published
as a successor version. Existing adopters continue to reference `v1` until they
explicitly adopt a successor.

## Adoption contract

This standard does not apply to a repository merely because the repository
belongs to the Agent Teams organization. Adoption is explicit.

An adopting repository MUST maintain one local profile that identifies:

- this standard by ID, version, canonical repository path, and content digest;
- the production roots, module roots, application roots, and excluded roots in
  scope;
- the repository-specific mapping from the abstract layout in this standard;
- local extensions, including language, packaging, transport, and composition
  rules;
- every deliberate deviation, with its scope, rationale, owner, and review
  trigger;
- the exact deterministic commands that enforce the adopted rules;
- the local architecture document and decision records that own repository
  specifics.

The profile MUST NOT copy this standard and present the copy as a second
authority. It MAY repeat a short rule only when necessary to explain a stricter
local constraint.

A repository MUST NOT claim conformance unless its profile is reachable from the
repository documentation entry point and the declared enforcement commands run
in its required quality gate.

Local profiles MAY strengthen this standard. A local profile MAY deviate only by
recording an explicit deviation. Silence is adoption of the central rule, not an
implicit exception.

## Architecture hierarchy

```text
repository
  -> production module with one architectural role
      -> feature-owned capability slice
          -> role-appropriate internal layers
              -> operations and behavior
```

A production module is a hard ownership and dependency boundary. Depending on
the repository, it may be a workspace package, library, service, executable
component, or another locally enforced module kind.

A feature is a cohesive domain or technical capability inside one module. A
feature is not an independent bounded context, service, or package by default.
A use case is one operation. Repositories MUST NOT create one module per endpoint
or one feature per class.

## Universal feature ownership

All production behavior inside an adopted production module MUST belong to an
explicit feature-owned capability slice.

A module-level source root MAY contain only:

- a curated public module entry point;
- composition that wires feature public entry points;
- module-level Published Language or migration assembly that indexes
  feature-owned artifacts without redefining them;
- generated artifacts in an explicitly isolated generated directory;
- narrowly scoped primitives whose ownership genuinely cannot belong to one
  feature.

The final exception MUST be approved by a repository-owned architecture
decision. Broad `shared`, `common`, `utils`, `services`, `core`, or
`infrastructure` directories are not valid substitutes for feature ownership.

Feature ownership is structural while modeling depth is semantic:

- domain capabilities use the tactical domain modeling and internal layers
  required by their invariants;
- integration capabilities own provider contracts, mappings, ports, and adapters
  without inventing a business domain model;
- platform capabilities own stable technical ports and implementation behavior
  without pretending infrastructure is a business domain;
- SDK capabilities are sliced by public client capability and own contracts,
  operations, mappings, and tests;
- testing capabilities own reusable fixtures, conformance suites, and harnesses
  by the capability they validate.

A module MUST begin with at least one real feature. It MUST NOT postpone feature
ownership until it becomes large. Empty feature, layer, or package scaffolding is
prohibited.

## Abstract repository layout

An adopting profile MUST map its concrete directories to these abstract roles:

```text
<production-module>/
  <source-root>/
    features/
      <feature>/
    <module-composition>/
    <public-entrypoint>
  <test-root>/
    features/
      <feature>/
    module/

<application-root>/
  <composition-root>/
```

Application executables SHOULD remain thin composition roots. They may assemble
features, transports, process-wide resources, and lifecycle handling, but MUST
NOT become an alternative owner of behavior already owned by a production
module.

Executable clients belong in application roots. Distributable client libraries
belong in explicitly supported SDK modules. Protocol clients used only by one
adapter SHOULD remain inside that adapter until reuse or lifecycle evidence
justifies extraction.

## Feature layout

A domain-capability feature may use the following role-oriented layout:

```text
features/<feature>/
  contracts/
  domain/
    aggregates/
    services/
    policies/
    specifications/
    errors/
  application/
    models/
    use-cases/
    policies/
    ports/
      inbound/
      outbound/
  adapters/
    inbound/
    outbound/
  composition/
```

This is not a mandatory folder template. A directory MUST exist only when it
contains a real owned artifact. A pure integration, platform, SDK, or testing
feature MAY use a smaller role-appropriate layout without a domain aggregate.

Aggregate-specific entities, value objects, factories, and domain events SHOULD
be colocated with their aggregate. Feature-level policy, service,
specification, error, or value-object directories SHOULD exist only when the
concept is genuinely shared by several aggregates inside the feature.

A user-interface action or verb is not automatically a separate feature. The
feature that owns the business invariant MUST own every mutation of its
aggregate.

## Test ownership

Tests MUST preserve feature ownership.

- Focused white-box unit tests SHOULD be colocated with the source they exercise.
- Feature contract, integration, adapter, persistence, and conformance tests
  SHOULD live under the module test root for that feature.
- Module export, declaration, packaged-artifact, and black-box consumer tests
  SHOULD live under a module-level test area.
- A generic detached unit-test tree that loses feature ownership SHOULD NOT be
  used.

Production builds and published artifacts MUST exclude test-only code. Test
configuration SHOULD be created with the first real test, not as empty
scaffolding.

## Growth guardrails

Feature ownership MUST be enforced mechanically rather than remembered only
during review. An adopting repository MUST provide deterministic checks that:

1. classify each production module by architectural role;
2. reject production behavior outside an allowed feature or module-assembly
   root;
3. enforce role-specific dependency direction and public feature entry points;
4. reject cross-feature deep imports and dependency cycles;
5. reject empty ceremonial layers;
6. require an explicit architecture decision for module-level ownership
   exceptions;
7. validate materialized modules against the repository-owned topology
   authority;
8. make the compliant creation path easier than a noncompliant path.

The repository MUST own its module identities, allowed paths, dependency edges,
and exceptions. Shared tooling MAY implement validation and scaffolding, but it
MUST NOT silently invent or widen repository policy.

Generators SHOULD use a reviewable Plan followed by deterministic Apply.
Interrupted generation SHOULD provide bounded recovery that does not depend on
unrelated repository validity.

## Layer responsibilities

### Contracts

Contracts own stable outer-boundary data, including:

- client commands, queries, results, and errors;
- bounded-context Published Language;
- integration events;
- transport schemas and compatibility metadata.

Contracts MUST NOT expose aggregate instances or infrastructure types. Domain and
application code MUST NOT import public transport contracts. Physical ownership
by a feature does not make contracts an inner layer.

Client APIs, Published Language, and integration events are distinct surfaces
even when one feature owns them. They may have different compatibility,
authorization, privacy, and disclosure rules and MUST NOT be reused merely to
avoid mapping code.

Each external contract surface MUST begin with one explicit first major version.
Speculative successor versions are prohibited. A later major requires a
repository-owned compatibility and migration decision.

An integration-event schema SHOULD have an accompanying manifest covering
ownership, authorization, privacy, ordering, delivery, retention, replay,
payload limits, and compatibility. Transport configuration MUST NOT be the only
authority for those semantics.

### Domain

Domain owns business meaning and invariants:

- aggregates;
- entities;
- value objects;
- domain events;
- domain services;
- invariant violations.

Domain behavior MUST be deterministic for the same explicit inputs. Time, IDs,
randomness, authorization facts, and external observations enter through
application orchestration.

### Application

Application owns use-case coordination:

- command and query handlers;
- transport-independent input and output models;
- transaction boundaries;
- coordination policies;
- inbound and outbound ports;
- authorization of business operations;
- mapping domain events to publication intent;
- staging durable external intent with state transitions.

Application code MUST NOT know which adapter implements a port and MUST NOT accept
an SDK or transport DTO directly.

Ordinary coordination SHOULD remain in named use cases. A durable, stateful
business process manager belongs to the feature whose business process it
coordinates. Shared platform code MAY provide scheduling, persistence, dispatch,
and test primitives, but MUST NOT absorb product workflow policy into a generic
workflow engine.

### Adapters

Inbound adapters validate external contracts and map them into application input
models. Outbound adapters implement application ports for persistence, runtime,
messaging, workflow, clocks, IDs, and external systems.

Direction is named relative to the application core:

- inbound initiates an application capability through an inbound port;
- outbound is invoked by application code through an outbound port.

A technology may appear on both sides. Bidirectional integration MUST expose
distinct inbound and outbound roles instead of hiding both behind a broad
gateway.

Feature-specific mappings, repositories, handlers, schemas, recovery policy,
tables, indexes, and migrations MUST remain with the owning feature. Module or
process composition MAY share low-level connections and lifecycle resources,
but MUST NOT become the owner of feature behavior.

An external-system adapter belongs to the feature that owns the use case, port,
mapping policy, and recovery decision. It SHOULD be promoted to a dedicated
integration module only after proven cross-feature reuse, independent lifecycle
or publication, or a dedicated provider conformance surface.

Adapters MAY contain technology-specific recovery and mapping behavior but MUST
NOT contain business invariants owned by the domain.

### Composition

Composition is an assembly responsibility, not a mandatory domain layer. It may
occur at three levels:

1. Optional feature composition wires feature-local handlers from exact typed
   dependencies.
2. Module composition wires feature factories, adapters, exports, and migration
   contributions.
3. Application composition creates process-wide resources and owns process
   lifecycle.

Feature composition MUST NOT create process-wide resources. A feature SHOULD
expose a narrow typed factory or equivalent constructor surface and MUST NOT
export a dependency-injection container.

Only the application composition root may:

- choose concrete cross-module bridges and adapters;
- order start, readiness, stop, and disposal lifecycles;
- roll back partially started composition;
- share technical connection pools without sharing feature repositories or
  transaction ownership.

Migration assembly may order and validate feature-owned contributions, but it
MUST NOT redefine feature schema or migration content. Features MUST NOT acquire
module-global migration locks or run migrations independently.

### Projections

Each owning module controls projections derived from its state and events. A
feature may own projection handlers and read models for its capability.
Cross-module client views SHOULD be assembled at an edge query-composition
adapter, not in a global projection domain.

Projection policy and projectors belong in application code, inbound event
handlers belong in inbound adapters, and read-model persistence belongs in
outbound adapters. `projections` is not a universal feature layer.

## Aggregate and internal-feature ownership

Every aggregate implementation has one owning feature. Another feature inside
the same bounded context or module:

- MAY depend only on an explicit narrow domain or application internal API;
- MAY use stable identities and shared Ubiquitous Language types exposed for the
  module;
- MUST ask the owning application capability to mutate the aggregate;
- MUST NOT import the aggregate repository or mutate aggregate internals.

Cross-aggregate workflows belong in application coordination or explicit process
managers. Published Language and anti-corruption layers are required across
bounded contexts, not as ceremony between every feature inside one context.

The module MUST maintain an explicit directed dependency graph between internal
features. Cycles MUST be resolved by moving a concept to its semantic owner,
introducing an application coordinator, or revisiting the feature boundary.

Domain code may consume only another feature's domain internal API. Application
code may consume domain or application internal APIs. Adapters MUST reach sibling
features through their own application core and composition. Internal API files
MUST be curated surfaces, not barrels over a whole layer, and MUST NOT expose a
repository, aggregate implementation, adapter, container, or framework type.

## Dependency mechanisms

Use exactly one dependency mechanism for each relationship:

1. An ordinary fixed dependency uses a static import and a typed factory or
   constructor.
2. A replaceable internal implementation uses a consumer-owned port selected by
   module or application composition.
3. A dynamically selected plugin or extension uses an explicit validated graph,
   immutable activation plan, exact provider bindings, and declared cardinality.

The third mechanism MUST be introduced only when a real capability requires
runtime provider selection, variable dependencies, or an independently managed
lifecycle.

Ambient containers, service locators, parent-container fallback, registration
order as semantics, and global mutable registries are prohibited.

## Public module surfaces

Each production module MUST expose deliberately separate public surfaces for the
capabilities it actually supports. Common surfaces include:

```text
module       module factory and lifecycle
api          provider-owned inbound application API
published    Published Language and public read contracts
contracts    external schemas
testing      fixtures and conformance kits
```

Consumer-owned outbound ports remain private unless a separately packaged
adapter must implement them. In that case, the module MAY expose one narrow
service-provider surface for the exact capability. Broad service-provider
barrels are prohibited.

Module exports MUST prevent consumers from importing feature internals.

## Shared code policy

A repository-wide shared kernel MUST NOT be created by default. It requires an
architecture decision that names owners, versioning policy, and exact consumers.
It MUST NOT contain generic aggregate bases, generic repositories, global
business errors, domain identities, product policies, provider branches, or
convenience services.

Stable technical contract primitives MAY live in a narrowly named contract
module when duplication would break interoperability. Context-local business
identities and concepts remain context-owned even when serialized values look
alike.

Before extracting shared code, answer:

1. Does it represent the same concept with the same lifecycle for every current
   consumer?
2. Would duplication be cheaper than semantic coupling?
3. Can the behavior be expressed through a contract instead?

## Promoting a feature to a module

The default is a feature-owned slice inside its existing module. A feature is
extracted only when it is ready and at least one of these conditions is proven:

| Evidence | Extraction condition |
| --- | --- |
| Hard boundary | Independent deployment, scaling, ownership, release, security, persistence, or external API lifecycle |
| Reuse | At least two real independent consumers require the same semantics |
| Public provider surface | At least two independent implementations pass the same conformance suite |
| Dependency lifecycle | Native, platform, post-install, incompatible, or independently updated dependencies require isolation |

Conceptually:

```text
EXTRACT = READY AND (BOUNDARY OR REUSE OR PUBLIC_PROVIDER_SURFACE OR DEPENDENCY_LIFECYCLE)
```

`READY` requires accepted semantic ownership, a curated public surface,
compatibility policy, executable tests, and a migration plan.

A feature MUST NOT be extracted merely for folder isolation, cache performance,
large file count, one adapter, or a hypothetical future consumer. Extraction
requires a repository-owned architecture decision. Moving a ready feature SHOULD
preserve its internal feature ownership; callers change only to the extracted
module's explicit public surface.

## Conformance evidence

An adopting repository SHOULD provide positive and negative fixtures for its
structural rules. At minimum, its deterministic gate MUST prove:

- one valid feature for every adopted module role;
- rejection of production behavior outside a feature;
- rejection of a cross-feature deep import;
- rejection of an undeclared dependency edge or cycle;
- rejection of an empty ceremonial layer;
- rejection of an undeclared module or ownership exception.

Conformance to this standard does not establish domain correctness, security,
operational readiness, or deployment qualification. Those claims remain owned by
the adopting repository.
