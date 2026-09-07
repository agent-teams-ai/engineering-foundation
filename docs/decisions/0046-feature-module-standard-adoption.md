---
id: ADR-0046
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0046: Repository Feature Module Standard Adoption

Status: Accepted adoption; existing layout migration remains incomplete

Date: 2026-09-05

Decision owner: Product owner

## Context

The product owner explicitly requested adoption of immutable Feature Module
Standard v1, full production quality coverage, and bounded ownership. Existing
capabilities already expose useful application, adapter and composition
boundaries. Root utilities and broad Authoring/MCP boundaries do not prove
feature ownership. Concurrent work does not justify a primitive exception.

## Decision

1. Adopt the exact supplied `agent-teams.feature-module-standard` v1 through
   [one local profile](../../architecture/foundation/feature-modules.json).
   Its canonical standard path and SHA-256 bind the unchanged organization
   standard. It must be included at that path in integrated source.
2. Reuse the existing publishable-package inventory and source-dependencies v2
   authority. Repository scripts execute its parser, resolver and policy;
   feature rules add ownership/layer restrictions without creating package
   edges. No consumer executable plugin or production runtime is introduced.
3. Current capability directories may map to real features. Mixed contract
   loaders are inbound adapters until their owning slice separates pure
   parse/map under ADR-0035. Do not relabel them as pure contracts.
4. Module roots permit curated exports and direct factory delegation only.
   Behavior, generic utility buckets, unowned files, ambiguous boundaries,
   empty directories and cycles fail closed. No primitive or cycle exception
   is accepted by this decision. A future primitive decision must name one
   exact file, semantic rationale, owner and review trigger.
5. Required checks execute full production scope and feature conformance.
   Ambient allowances are exact files owned by real infrastructure or
   qualification features. Typed rules and budgets remain unchanged.
6. A creation command emits a reviewable plan from the caller's real first
   artifact, including ownership and source-policy entries. It does not
   materialize empty layers or invent a domain aggregate.

## Consequences

The [local architecture document](../architecture/feature-module-standard.md)
records the mapping and bounded migrations. The working guard intentionally
fails on unresolved layout gaps. Adoption is not a claim of whole-repository
conformance or release readiness. The coordinator integrates other owners'
changes and retains exact failing paths/edges until bounded migrations pass.
