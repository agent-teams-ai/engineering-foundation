---
id: ADR-0064
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0064: Independent Stack Toolchain Package Boundary

## Context

Independent TypeScript projects need one versioned owner for executable pins,
technical presets and checker fallback. Engineering Foundation owns governance,
quality scope and its existing command orchestration; node-or-bun owns the
process mechanism. None of those owners needs a second implementation.

## Decision

1. Add the independently published, architecture-neutral `stack-toolchain`
   package. Its public name and CLI do not require an organization identity,
   Foundation installation or organization credentials. It owns tool versions,
   executable resolution, presets and explicit typecheck, lint, format-check,
   compile and doctor commands. Consumers own source scope, project settings,
   environment types, outputs and tests.
2. This is a scoped amendment of ADR-0043's closed package graph, alongside
   ADR-0062. Add one independent node and no dependency on another package in
   this monorepo. Toolchain imports the exact published node-or-bun process
   mechanism; it never imports Foundation or copies a spawn engine. Foundation
   can inspect an installed consumer Toolchain and execute its commands without
   making Toolchain depend on Foundation. Every other accepted edge remains
   unchanged. Whole-document supersession metadata stays empty because the
   remainder of ADR-0043 remains accepted.
3. Production dependencies and development bootstrap are distinct. A released
   Toolchain depends on an already published node-or-bun version. A later
   node-or-bun release may use an already published Toolchain as a development
   dependency only. No source links, floating ranges or simultaneous mutual
   release are required.
4. One cohesive `toolchain-execution` feature owns the fallback policy and its
   fixed adapters. Policy receives typed execution and clock dependencies;
   adapters own filesystem, executable and process access. The public root and
   CLI are exact outer assembly files. This static library introduces no
   independently assembled Host scope, dynamic plugin, lifecycle manager or
   Get Modular adoption. The existing FMS profile and source policy enforce
   these owners; helper files do not become composition graph nodes.
5. The checker group runs sequentially: tsrs, then Bun only after qualified
   engine failure or unavailability, then official TypeScript only if both
   earlier engines failed or were unavailable. Success ends the chain. Project
   diagnostics, cancellation, unknown failure formats, incomplete capture and
   uncertain cleanup are terminal. Fallback restarts the complete project group
   under the original deadline. Compilation remains an explicit output-producing
   operation; the initial read-only profile rejects project references.
6. Qualification uses disposable projects and the packed artifact, together
   with a real consumer in the same delivery. Engine failures, diagnostics,
   cancellation and unchanged checked inputs are observable acceptance cases.
   Platform support is claimed only from actual native qualification. Root
   scripts, complete test inventories and existing release gates include the
   package. Source admission is not publication or consumer-adoption evidence.
7. The source starts at `0.0.0` with a minor Changeset. The existing API baseline
   bootstrap extracts its declarations at that version; no handwritten API
   baseline is accepted. The first supported release is `0.1.0`. Later MVP
   breaks use a minor release, changelog and migration guide. Namespace
   authentication and published registry evidence remain release concerns.

## Consequences

Tool updates have one package owner and consumers upgrade one exact development
dependency. Toolchain has no business architecture, governance runtime or task
scheduler. Foundation keeps scope qualification, process containment and its
quality-gate DAG. node-or-bun keeps direct-child execution and cleanup semantics.
The static package graph, published artifacts and consumer adoption remain
separate claims, checked by their existing owners.
