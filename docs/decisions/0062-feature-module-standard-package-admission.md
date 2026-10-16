---
id: ADR-0062
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0062: Feature Module Standard Package Admission

Status: Accepted. Decision owner: Product owner. Date: 2026-10-16.

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
   `packages/feature-module-standard/`. Shared checks of FMS semantics live
   only in this opt-in package, and the neutral core gains none. The known
   exception of `quality.source-coverage`, which reads an FMS profile, stays as
   [Architecture neutrality](../architecture/executable-capabilities.md#architecture-neutrality)
   records it until its own migration, and Engineering Foundation's repository
   checker keeps only the repository-specific rules of point 4. No other
   package depends on this package, and an Engineering Foundation test proves
   it. The dependency direction runs only from this package to the neutral
   core, as Architecture neutrality requires.
2. Package graph. Like `@agent-teams/ci-input-proof`, the package is an
   independent source package outside the documentation Cohort of
   [ADR-0043](0043-new-only-portable-documentation-package-boundary.md).
   ADR-0043 calls its target DAG the only manually maintained target graph and
   closes its edges; this record amends that graph only by this package's node
   and the edge below. It is a scoped amendment in the way ADR-0043 is a
   scoped supersession of ADR-0039: repository lifecycle metadata models
   whole-document supersession, so `supersedes` stays empty and every other
   part of ADR-0043 stays accepted.
   The accepted target is:
   - `.` and `./fixtures` import no package and no Node built-in, and the
     manifest declares no runtime or peer dependency for them;
   - the runner `./node` has exactly one edge, an optional peer dependency on
     the public subpaths of `@agent-teams/engineering-foundation`;
   - the neutral core gains no edge.

   The edge is accepted now as the target. Whether it is implemented is recorded
   in [ownership](../architecture/ownership.md) and the
   [release documentation](../release.md), never by editing this record.
3. Admission under [ADR-0061](0061-library-first-foundation-boundary-evolution.md)
   point 1:
   - Why reuse is expected: Agent Runtime and the Get Modular test project adopt
     v1.1 in the Get Modular 0.5.0 train (its phases N2 and P6), Engineering
     Foundation's own checker is the first consumer, and further repositories
     adopt the standard by profile.
   - How the contract evolves: the input is declared facts (feature roots, role
     mapping, curated surfaces, republications, declared use edges, import
     records) and the output is diagnostics with stable codes plus per-feature
     metrics. The kernel reads no files, runs no parser and widens no policy.
     It exports the identity and digest of the exact standard text it implements.
     A change of an API or of a diagnostic code is a minor release of the 0.x
     package with a changelog entry and a migration note.
   - Same-delivery validation, complete before the first publication: shared
     conformance fixtures (`./fixtures`) run as the kernel's own tests. The
     disposable project is the example tree of the standard, exported as a
     module description and as source texts; the kernel tests read the texts
     back with a minimal reader, and the runner's acceptance reads them
     through the public source graph. The real consumer is the Engineering
     Foundation checker, see point 4.
4. Adoption sequence. The kernel takes the structure the
   profile declares as input: the root of every feature, and directories or
   single files mapped to roles. Feature layout is not a mandatory folder
   template, so the kernel does not infer owners from directory names;
   `inferDirectoryLayout` builds the same input for a tree that follows the
   default layout. Engineering Foundation's checker builds that input from
   `architecture/foundation/feature-modules.json` and its observed source graph
   (`scripts/feature-modules/kernel.mjs`) and calls `checkFeatureModule` once per
   module, failing closed on any kernel error it cannot translate. The kernel now
   owns feature-to-feature deep imports, layer direction and cycles inside a
   module, together with path containment and ownership-root
   overlap, and the repository's duplicated code for them is deleted.
   Before the deletion, the old and the new checker were compared on the real
   source graph and on synthetic feature-to-feature edges: they reject the
   same cases with the same deep-import and layer-direction findings, and
   cycles are compared by component. The admission note records the commits,
   the method and the numbers.
   The shared fixtures that a flat repository profile can express run through
   the repository checker's kernel adapter, from a profile built for each
   fixture, as its conformance test
   (`tests/feature-module-kernel-adapter.test.mjs`).
   Local rules stay in Engineering Foundation and are strengthenings, not copies:
   a contracts layer never imports another feature; another module's exported
   API is judged with the inside-one-feature table; primitives, module assembly
   files and cross-module edges keep their repository rules. Cycles between
   features of different modules are package cycles, which the source-dependency
   policy already rejects. Fixtures with sub-features cannot be written as a
   repository profile, so only the flat ones run there.
   Agent Runtime's checker adopts the kernel later and runs the same fixtures
   as its conformance test; the Get Modular test project uses the runner.
   Inside Engineering Foundation an old and a new implementation never stay
   side by side; Agent Runtime's checker keeps its overlapping rules only until
   its own adoption deletes them, which is their owner and removal step.
5. Engineering Foundation's own profile stays on v1 and declares no sub-feature
   and no composition contract; its checker rejects nested feature roots. It
   uses the v1.1 kernel only for rules that v1.1 leaves unchanged for such a
   module ("for any other module, every `v1` requirement is unchanged"), so the
   profile's v1 pin and digest remain its conformance claim. Moving to v1.1
   needs its own profile change and decision.
6. Admission is for source use. This record authorizes no publication and no
   bootstrap approval. The package enters
   `architecture/foundation/npm-package-bootstrap.json` as a candidate without
   approval, and the owner's approval is recorded there, never here. Because
   the closed publishable catalog includes the package, every `release:publish`
   of this repository fails closed until that approval and the bootstrap
   publication exist; the admission note records the release order.

## Consequences

- One implementation of the nested-feature rules, with one set of fixtures that
  every adopting checker runs.
- v1.1 can change while it settles without an Engineering Foundation major.
- The kernel keeps its own small cycle search so that `.` stays
  dependency-free. It is a deliberate copy of a generic mechanism that the
  neutral core exports on `./source-graph`, not a second owner of it.
- What remains for the runner: feature root discovery and import reading
  through the public source graph, growth warnings through the budgets, the
  peer dependency and the implemented status of the edge in point 2.

## Rejected alternatives

- A subpath of `@agent-teams/engineering-foundation`: an FMS break would need
  an Engineering Foundation major, and the core would carry one architecture's
  rules.
- A checker inside each adopting repository: the tree, visibility, edge and
  cycle rules would be copied and drift.
- Owners inferred from directory names in the kernel: the layout is a profile
  mapping, not a folder template.
