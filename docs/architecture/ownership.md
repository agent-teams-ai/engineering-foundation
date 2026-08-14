# Ownership Boundary

The foundation owns reusable engineering mechanisms:

- configuration contracts and generic validators;
- tool presets and capability runners;
- local versus registry lifecycle tooling;
- generic scaffolding primitives and conformance fixtures;
- publishable package and release mechanics.

A consumer owns business and repository facts:

- bounded contexts and feature topology;
- package identities and allowed dependency relationships;
- data classifications and threat scenarios;
- domain terminology, ADRs, and open decisions;
- project-specific capability configuration and fixtures.

The consumer supplies those facts through a narrow configuration adapter. The
foundation validates and executes them but cannot invent or override them.

The accepted scaffolding boundary applies the same ownership rule to mutation.
Foundation owns the closed deterministic compiler and execution protocol. A
consumer owns approved compositions and resolves its catalog and architecture
facts through data-only adapters. Templates remain private implementation
details, while Nx is an optional workspace adapter. See
[Scaffolding compiler protocol](scaffolding-compiler-protocol.md).

Capabilities are feature-owned policy surfaces with granular identifiers. Broad
menu categories such as `architecture` or `documentation` are not capability
boundaries. The built-in registry is static and private; consumers provide data,
not executable plugins or rule functions.

Package-manager files, source parsers, and other external formats are outbound
adapter concerns. Their objects do not become capability policy models. The
first accepted split is:

- `workspace.dependency-declarations` for declared workspace dependency state;
- `architecture.source-dependencies` for observed source relationships.

The complete contract, compatibility, and migration rules are defined by
[Executable capabilities](executable-capabilities.md).

The foundation is not a production dependency and is not a shared business
kernel.

Document authoring follows the same ownership boundary but remains a separate
top-level mutation protocol rather than an executable capability. Foundation
owns closed contracts, deterministic compilation, protected materialization,
and recovery. Consumers own document types, lifecycle, metadata, owner meaning,
templates, placement meaning, body rules, relationships, and prose or diagram
tools. Profiles are data-only and cannot load consumer code. See the
[Document authoring protocol](document-authoring-protocol.md).

ADR-0025 separates the documentation-specific application layer from this
kernel. `@agent-teams/docs-protocol` may depend on Foundation and owns the common
documentation commands, vocabulary, query behavior, and agent workflow.
Foundation cannot depend on Docs Protocol. Consumers still own their data-only
profiles, schemas, owners, templates, reachability, and semantic validators;
neither shared package accepts executable consumer extensions.

The corrected authoring v1 applies that split mechanically. Foundation owns
Intent normalization, closed ID/placement operators, filename slug derivation,
canonical frontmatter and domain-separated protocol digests. A complete rebuilt
catalog is required before planning. Consumer metadata remains bounded opaque
data: Foundation binary-sorts generic mapping keys, preserves array order, and
never assigns meaning or priority to consumer field names. The consumer metadata
schema remains the final authority for shape and meaning.

Foundation mutation protocols share one private transaction-coordination
application boundary. Its ports model only cooperative lock ownership and
persisted-slot observation; Node adapters provide filesystem inspection and the
composition root. Scaffolding and document authoring retain distinct Plans,
Receipts, errors, and recovery handlers, and no consumer-programmable mutation
kernel is exported.

Executable specification connectivity follows the same boundary. Foundation
owns strict catalogs, contained artifact inspection, local JSON Schema
validation, and deterministic diagnostics. Consumers own domain schemas and
documents, generated types, evaluators, properties, mutation setup, package
scripts, XState models and adapters, traces, diagrams, and the CI that executes
their gates. The optional v1 state-model evidence profile is XState-shaped, but
Foundation owns no XState runtime or domain semantics and proves wiring, never
consumer gate success. Axis identifiers are opaque to Foundation; consumers own
their meaning, independence, and parity evidence. Other state-model formalisms
require a separately versioned and qualified contract extension rather than
reinterpretation of v1.
