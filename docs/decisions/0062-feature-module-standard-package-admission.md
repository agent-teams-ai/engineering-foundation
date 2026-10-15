---
id: ADR-0062
status: proposed
supersedes: []
superseded_by: []
---

# ADR-0062: Feature Module Standard Package Admission

Status: Proposed. Decision owner: Product owner. Date: 2026-10-15.

## Context

The organization's Feature Module Standard (`agent-teams.feature-module-standard`)
v1.1 adds sub-features, composition contracts and the rules they need. Several
repositories will check it: Engineering Foundation itself, Agent Runtime, the
Get Modular test project and later others. Each of them would otherwise grow its
own copy of the same tree, visibility, edge, republication and cycle rules.

On 2026-10-11 the Product owner chose a separate 0.x package named after the
standard instead of a subpath of `@agent-teams/engineering-foundation`. Reasons:
Engineering Foundation is 1.x, so a break of an FMS API inside it would need a
major release, while a 0.x package ships breaks as minor releases with a
migration note while v1.1 settles; the neutral core cannot import an undeclared
package, so its neutrality is physical (rule `undeclared-workspace-dependency`
of `architecture.source-dependencies`, which this repository runs on itself);
and consumers load a dependency-free kernel.

## Decision

1. Add `@agent-teams/feature-module-standard` 0.1.0 under
   `packages/feature-module-standard/`. FMS semantics live only in this opt-in
   package. No other package depends on it, and an Engineering Foundation test
   proves it. The dependency direction runs only from this package to the
   neutral core, as
   [Architecture neutrality](../architecture/executable-capabilities.md#architecture-neutrality)
   requires.
2. Amend the package dependency DAG of
   [ADR-0043](0043-new-only-portable-documentation-package-boundary.md), which
   stays accepted and unchanged and remains the sole authority for that graph,
   with one node and no other edge changed:

   ```mermaid
   flowchart LR
       FMS["@agent-teams/feature-module-standard"]
       FMS -. "./node only, peer dependency, lands with the runner" .-> Foundation["@agent-teams/engineering-foundation"]
   ```

   - `.` and `./fixtures` have no monorepo package dependency and no runtime
     dependency at all. This delivery ships only these two subpaths, so today the
     node has no edge.
   - The runner `./node` follows once the public source graph of Engineering
     Foundation is merged. It adds exactly one edge, a peer dependency on the
     public subpaths of `@agent-teams/engineering-foundation`, optional for users
     of `.` alone. The runner's delivery updates this record's graph from target
     to implemented.
   - The core `@agent-teams/engineering-foundation` gains no edge.
3. Admission under [ADR-0061](0061-library-first-foundation-boundary-evolution.md)
   point 1:
   - Why reuse is expected: Agent Runtime and the Get Modular test project adopt
     v1.1 in the same train, Engineering Foundation's own checker is the first
     consumer, and further repositories adopt the standard by profile.
   - How the contract evolves: the input is declared facts (feature roots, role
     mapping, curated surfaces, republications, declared use edges, import
     records) and the output is diagnostics with stable codes plus per-feature
     metrics. The kernel reads no files, runs no parser and widens no policy.
     A change of an API or of a diagnostic code is a minor release of the 0.x
     package with a changelog entry and a migration note.
   - Same-delivery validation: shared conformance fixtures
     (`./fixtures`) run as the kernel's own tests and as the conformance test of
     Engineering Foundation's checker. The disposable project is the example tree
     of the standard (the fixtures' base module). The real consumer is the
     Engineering Foundation checker, moved onto the kernel before the first
     publication. Agent Runtime and the Get Modular test project adopt later and
     run the same fixtures.
4. Adoption sequence. Engineering Foundation's checker
   (`scripts/feature-modules/profile.mjs`, `dependencies.mjs`) takes ownership
   path containment, ownership-root overlap, v1 layer direction and cycle search
   from the kernel and deletes its own copies. Repository-specific rules stay
   in Engineering Foundation: module roles, factory purity, surface indexing,
   assembly facts and the repository profile. Engineering Foundation's own
   profile stays on v1 and declares no sub-feature. Consumers delete the code of
   every rule they hand to the kernel; an old and a new implementation do not
   stay side by side.
5. Two local strengthenings of Engineering Foundation's profile stay outside the
   kernel and are applied on top of it: a contracts layer never imports another
   feature, and another module's exported API is judged with the
   inside-one-feature table.
6. Admission is for source use. The first publication of the new npm name is a
   separate owner step. This record authorizes no publication.

## Consequences

- One implementation of the nested-feature rules, with one set of fixtures that
  every adopting checker runs.
- v1.1 can change while it settles without an Engineering Foundation major.
- Engineering Foundation's own checker proves the kernel on a real profile
  before anyone else depends on it.
- What remains for the runner: feature root discovery and import reading
  through the public source graph, growth warnings through the budgets, the peer
  dependency and the graph update of point 2.
