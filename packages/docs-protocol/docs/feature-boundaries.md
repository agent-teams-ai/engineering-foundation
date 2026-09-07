# Portable feature boundaries

Portable Docs Protocol has four feature owners:

- `portable-documentation` owns profile and relationship policy, authoring,
  checking, catalog queries and bounded context. YAML decoding and MiniSearch
  are outbound adapters. The application receives `CompiledOutputReader` and
  the existing `CommunitySearchIndex`; each Node protocol instance gets its own
  search index. Binary queries need no provider result. Ranking remains advisory.
- `portable-bootstrap` owns desired files, managed AGENTS blocks, bootstrap
  planning, apply preflight and recovery routing. Its repository port returns
  immutable base64 observations and modes. Its transaction port accepts closed
  create/replace data and retains a serialized, validated mutation Plan. File
  handles, stat objects and mutable Node buffers stay in the filesystem adapter.
- `docs-command` owns SDK command envelopes, CLI parsing, human and JSON presentation and process signal
  handling. Composition selects documentation and bootstrap APIs. This separate
  command owner keeps bootstrap's dependency on documentation's routing limit
  acyclic. The executable root only starts the composed command.
- `qualification` owns the disposable consumer harness and its filesystem/crash
  adapters. It consumes curated documentation testing and bootstrap application
  surfaces; it carries no production documentation authority.

The documentation application returns operation data. SDK adapters project the
same public versioned envelopes and exit codes. The module entrypoints assemble
explicit named feature exports. No old private source path forwards to a new
implementation, and installed API names and schema bytes remain unchanged.

Authoring ports carry documentation-owned catalog facts and read-only Plan
observations. The originating outbound adapter retains the exact provider Plan
in a private WeakMap until apply. A different or reconstructed observation cannot
select another artifact. The provider still validates authority, cancellation,
exact preimages and recovery evidence. No journal is translated or rewritten.

The output parser decodes the actual compiled output using the existing YAML
library. The pure projector validates metadata bounds and builds the compiled
view. Duplicate-key, alias and malformed-frontmatter errors retain their current
messages, and arbitrary metadata remains consumer-owned data.

Profile v3 keeps its historical blocker and path rules. Profile v4 explicitly
selects its vocabulary and path policy. Reviewed apply still checks the preview
Plan digest, recaptures policy and authority, and checks required anchors before
publication. Direct apply remains available without a preview digest.

The coordinator owns shared feature-profile, source-policy and root test-path
projections. The handoff supplies exact fragments for those owners. Package tests,
package-wide typed lint, changed and fast feedback provide local evidence; shared
feature conformance and integrated artifact/platform gates remain coordinator
responsibilities.
