# ADR-0006: Closed Deterministic Scaffolding Compiler

Status: Accepted

Date: 2026-08-02

Decision owner: Product owner

## Context

Agent Teams repositories need a reusable way to create packages and feature
slices without copying generators or allowing a generator to invent a
consumer's business architecture. The orchestrator has a useful local package
scaffolder, but its package-only output is intentionally insufficient until a
real feature slice is added. Nx is available for workspace graph and generator
integration, but not every current or future consumer is an Nx TypeScript
workspace.

A decade-lived multi-repository foundation needs stable execution semantics now
without freezing speculative recipes, a universal architecture DSL, or a public
plugin API before repeated vertical slices prove them.

## Decision

1. Design and version the complete framework-neutral scaffolding protocol now,
   while implementing recipes and facets incrementally through proven vertical
   slices.
2. Use the closed flow `Intent -> Plan -> Apply -> Receipt`. The Plan is
   immutable, content-addressed, contains final file bytes and complete
   preconditions, and is the only authority an apply adapter executes.
3. Use distinct composition concepts:
   - `ScaffoldProfile` selects one resolved technical environment;
   - `Recipe` represents one creation intent;
   - `Facet` contributes one optional orthogonal concern through declared
     composition slots;
   - `Composition` is a consumer-approved binding of one profile, one recipe,
     allowed facets, fixed parameters, and mandatory policies;
   - `Policy` is a monotonic blocking invariant;
   - `Template` is a private rendering implementation detail.
4. Reserve the term `preset` for reusable tool configuration bundles such as
   TypeScript and Oxlint presets. It is not a scaffolding composition primitive.
5. Keep a static, closed registry of Foundation-owned recipe, facet, policy,
   codec, and renderer implementations. Consumers provide strict data and
   authority facts, never executable hooks, callbacks, template engines, shell
   commands, or merge algorithms.
6. Consumers remain authoritative for package identities, bounded contexts,
   feature ownership, business names, accepted documents, allowed combinations,
   and project-specific policies. Foundation cannot invent or duplicate those
   facts.
7. Facets are an order-independent set. Dependencies and conflicts are
   explicit. Last-write-wins, numeric priority, profile inheritance trees, and
   implicit facet activation are prohibited.
8. Foundation initially ships the compiler kernel, schemas, filesystem adapter,
   CLI, and proven definitions in `@agent-teams/engineering-foundation`. Nx
   integration becomes a separate `@agent-teams/engineering-foundation-nx`
   package only when implemented and qualified. It translates the same Plan to
   an Nx `Tree` and owns no templates or architecture policy.
9. Version npm packages, protocol envelopes, component parameter contracts,
   definition revisions, and adapter compatibility independently. Installing a
   new package version never enables a new recipe, facet, composition, or policy
   in a consumer automatically.
10. Do not expose a public recipe/facet plugin API in the first implementation.
    New definitions move through normal Foundation releases after conformance
    against a real consumer. A public extension surface requires a later ADR.

## Consequences

- The stable investment is the deterministic protocol and merge algebra, not a
  large catalog of speculative templates.
- A repository may narrow and parameterize approved compositions without
  forking the compiler or duplicating generic generator code.
- Full DDD can be selected for a complex bounded-context slice but is not a
  universal profile default for SDKs, adapters, application hosts, frontend
  features, tests, or tooling.
- Filesystem execution promises journaled recoverability, not impossible
  multi-file atomicity. Nx execution reports host-managed commit semantics.
- The existing orchestrator package scaffolder is a donor and parity oracle, not
  yet the reusable reference recipe. The first extracted recipe must produce a
  valid accepted vertical result rather than ceremonial folders or placeholder
  business code.
- The kernel and testing-only conformance vertical may ship before product
  recipes. A reusable product recipe remains pending until a real donor vertical
  and a second consumer prove the boundary.

## Rejected alternatives

- Make Nx generators the canonical compiler and template authority.
- Build a universal YAML template, patch, or architecture DSL.
- Allow consumer JavaScript plugins, dynamic imports, remote templates, or
  post-generation format/install hooks.
- Implement every anticipated backend, frontend, Electron, SDK, and Rust recipe
  before two consumers prove the composition model.
- Keep repository-local generators as independent long-term authorities.

The canonical target design is
[Scaffolding compiler protocol](../architecture/scaffolding-compiler-protocol.md).
