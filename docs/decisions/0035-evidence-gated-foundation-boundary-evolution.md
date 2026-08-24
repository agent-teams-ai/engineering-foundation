---
id: ADR-0035
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0035: Evidence-Gated Foundation Boundary Evolution

Status: Accepted

Date: 2026-08-25

Decision owner: Product owner

## Context

Foundation intentionally exposes some concrete Node adapters, qualification
helpers, and compatibility aliases. Removing them immediately would create a
breaking migration without proving a safer consumer contract. At the same time,
promoting every similar implementation into a generic public framework would
couple unrelated bounded contexts and turn Foundation into a plugin platform.

Capability contract loaders also currently combine filesystem input, schema
validation, and mapping into application models. Their behavior is covered, but
the mixed responsibility makes future changes harder to review and reuse.

## Decision

1. A reusable Foundation component is extracted only when two real consumers
   need the same semantics, parity fixtures prove that equivalence, and the
   extraction deletes the duplicated consumer implementations. Similar-looking
   code alone is not evidence for a shared abstraction.
2. Shared contracts describe stable domain behavior, not provider lifecycle,
   runtime injection, or a generic plugin framework. Provider-specific policy
   remains in the owning consumer until the extraction rule is satisfied.
3. Existing concrete and qualification exports remain compatibility seams. New
   consumers use the narrowest supported subpath. A seam may be deprecated only
   after a repository-wide import audit and an equivalent narrow contract exist.
4. Removing or changing a released seam requires a documented consumer
   migration, parity evidence, and the next declared breaking release. Public API
   baselines continue to fail closed before that release.
5. New capability slices separate inbound loading from pure validation and
   application mapping. Existing `contract/config.ts` loaders migrate
   opportunistically when their slice changes; a repository-wide rewrite is not
   required before delivery of unrelated capabilities.
6. Pure parsing and mapping accept values or bytes and have no filesystem
   authority. Node filesystem access stays in an inbound adapter or composition
   root. Domain and application code do not import that adapter.
7. Each migrated slice keeps byte- and diagnostic-parity fixtures. Invalid input
   must remain fail closed, bounded, and attributable to the same capability.
8. Foundation may dogfood released Foundation contracts through source-built
   workspace composition, but release artifacts must not depend on themselves or
   require a previously published copy to build.

## Migration sequence

1. Record current imports of concrete, qualification, and compatibility exports
   in real consumers.
2. Introduce a narrow subpath only for a demonstrated consumer contract and add
   parity fixtures before moving either consumer.
3. Migrate both consumers, remove their duplicate implementations, and mark the
   old seam deprecated without changing behavior.
4. Remove a deprecated seam only in a declared breaking release after all owned
   consumers have moved and public API evidence approves the change.
5. When an existing capability contract changes, first extract its pure
   parse/map function, retain the old loader as an adapter, and prove diagnostic
   and output parity.

## Consequences

- Foundation grows as opt-in bounded components instead of one universal
  runtime.
- DRY is based on identical reasons to change, not superficial code similarity.
- Current consumers remain compatible while public boundaries become narrower
  through evidence-backed migrations.
- Contract loaders improve slice by slice without a large speculative refactor.
- Some concrete seams and mixed loaders remain visible debt until real consumer
  work supplies migration evidence.

## Rejected alternatives

- Remove all concrete exports immediately to obtain a cleaner snapshot.
- Publish a generic provider or plugin framework before two consumers share its
  semantics.
- Move similar code into Foundation while retaining duplicate consumer copies.
- Rewrite every capability loader in one cross-cutting migration.
- Make published Foundation packages depend on their own previously published
