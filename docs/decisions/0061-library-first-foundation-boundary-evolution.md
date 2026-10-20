---
id: ADR-0061
status: accepted
supersedes: [ADR-0035]
superseded_by: []
---

# ADR-0061: Library-First Foundation Boundary Evolution

Status: Accepted

Date: 2026-10-15

Decision owner: Product owner

## Context

ADR-0035 point 1 admitted a reusable Foundation component only after two real
consumers needed the same semantics. On 2026-10-15 the Product owner rejected
that gate: Foundation is designed for many consumers, and the fact that a second
consumer does not exist yet does not mean the code will not be reused. Waiting
grows the concern inside one consumer and turns its later extraction into a
costly migration. This aligns Foundation with the organization's
[Library-first design and deliberate evolution](https://github.com/agent-teams-ai/.github/blob/66d6d3d2c2643edac414ded48c0ee0586774dd07/docs/engineering-quality-standard.md#library-first-design-and-deliberate-evolution)
rule. The other points of ADR-0035 stay valid and are restated here so one
decision is the authority.

## Decision

1. Foundation is designed for many consumers. A reusable engineering-tooling
   concern within Foundation's ownership boundary that is expected to serve
   more than one repository is implemented in Foundation as a shared component
   from the start, instead of growing inside one consumer and being extracted
   later. The number of consumers that exist today is not an admission gate.
   The admission states why reuse is expected and how the contract will
   evolve, and the same delivery validates the contract with disposable test
   projects and at least one real consumer; that consumer proves the contract
   and is not an incubator for it. A component carries only mechanism with a
   concrete need. Every admission ships shared parity fixtures and a
   conformance test in every adopting consumer, and the adoption sequence
   deletes the superseded consumer implementations; an old and a new
   implementation do not stay side by side without an owner and a removal
   step. Similar-looking code alone is not evidence for a shared abstraction:
   a shared contract generalizes only the semantics it defines, and product
   policy stays in the consumer.
2. Shared contracts describe stable domain behavior, not provider lifecycle,
   runtime injection, or a generic plugin framework. Provider-specific policy
   remains in the owning consumer.
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
9. Capability-specific qualification stages in other accepted decisions, such as
   the staged recipe qualification of ADR-0017 and the Agent Architecture
   Standard admission rule of ADR-0036, stay until their own decisions change.

## Migration sequence

1. Record current imports of concrete, qualification, and compatibility exports
   in real consumers.
2. Introduce a narrow subpath for the shared contract and add parity fixtures
   before moving any consumer.
3. Migrate every adopting consumer, remove their duplicate implementations, and
   mark the old seam deprecated without changing behavior.
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
- Shared concerns land in Foundation when reuse is expected, without waiting for a
  second consumer; parity fixtures, conformance tests and deletion of duplicates
  keep DRY honest.

## Rejected alternatives

- Remove all concrete exports immediately to obtain a cleaner snapshot.
- Publish a generic provider or plugin framework.
- Move similar code into Foundation while retaining duplicate consumer copies.
- Rewrite every capability loader in one cross-cutting migration.
- Make published Foundation packages depend on their own previously published
  copy to build.
- Keep the two-consumer gate of ADR-0035: it grows expected shared concerns
  inside one consumer and makes their extraction a later migration.
