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
top-level mutation protocol rather than an executable capability. Consumers own
document types, lifecycle, metadata, owner meaning, templates, placement
meaning, body rules, relationships, and prose or diagram tools. Profiles are
data-only and cannot load consumer code. See the
[Document authoring protocol](document-authoring-protocol.md).

[ADR-0043](../decisions/0043-new-only-portable-documentation-package-boundary.md)
accepts the new-only package ownership target. Implementation is pending, and
that ADR is the sole authority for the target dependency DAG. In the target:

- `@agent-teams/repository-mutation` owns portable operation barriers,
  exact-preimage known-file transactions, journals, and exact-build recovery;
- `@agent-teams/document-authoring` owns portable authoring contracts,
  deterministic compilation, catalog semantics, and protected materialization;
- `@agent-teams/engineering-foundation` owns reusable engineering policy and
  capability tooling, composed over those portable mechanisms;
- `@agent-teams/docs-protocol` owns the portable documentation application,
  commands, query behavior, projections, and agent workflow;
- `@agent-teams/docs-protocol-agent-teams` owns all Agent Teams managed
  implementation, assets, and Qualified Cohort integration; and
- `@agent-teams/docs-protocol-mcp` owns only the optional read-only transport.

`agent-teams-docs-managed` retains its consumer-owned managed policy and
evidence. Organization governance retains Qualified Cohort and enrollment
authority. Neither portable Docs Protocol nor MCP can load the Agent Teams
adapter, including by optional or dynamic import. The cutover adds no old-root
exports, aliases, forwarding facade, or runtime autodetection; current consumers
must be inventoried and have explicit reviewed migration changes prepared before
publication. Those changes adopt exact published pins only after protected
registry and provenance proof, then prove fleet closure in the approved rollout.

ADR-0030's exact-preimage mutation and ADR-0037's disposable package-manager
staging remain behavioral requirements, but their target implementations move
to the owners above. Retiring a legacy command entrypoint does not retire a
journal, transaction reader, or exact-build recovery handler. Incompatible or
ambiguous persisted evidence continues to fail closed.

ADR-0033 still governs its existing legacy entrypoint until its independent
removal evidence is complete. It does not authorize a compatibility bridge in
the new packages, and its compatibility surface is not a reason to copy legacy
exports into the target boundary.

The corrected authoring v1 semantics remain unchanged through the split. The
portable authoring owner retains Intent normalization, closed ID/placement
operators, filename slug derivation, canonical frontmatter, and domain-separated
protocol digests. A complete rebuilt catalog is required before planning.
Consumer metadata remains bounded opaque data: generic mapping keys are
binary-sorted, array order is preserved, and no shared package assigns meaning
or priority to consumer field names. The consumer metadata schema remains the
final authority for shape and meaning.

Portable mutation protocols share one closed transaction-coordination boundary.
Its ports model only cooperative lock ownership and persisted-slot observation;
Node adapters provide filesystem inspection and composition. Scaffolding and
document authoring retain distinct Plans, Receipts, errors, and recovery
handlers, and no consumer-programmable mutation kernel is exported.

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
