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
2. Package graph. Like `@agent-teams/ci-input-proof`, the package is an
   independent source package outside the documentation Cohort of
   [ADR-0043](0043-new-only-portable-documentation-package-boundary.md). ADR-0043
   stays accepted and unchanged; this record is the authority for the package's
   own node. The accepted target is:
   - `.` and `./fixtures` have no package dependency of any kind;
   - the runner `./node` has exactly one edge, a peer dependency on the public
     subpaths of `@agent-teams/engineering-foundation`, optional for users of `.`
     alone;
   - the neutral core gains no edge.

   The edge is accepted now as the target. Whether it is implemented is recorded
   in [ownership](../architecture/ownership.md) and the
   [release notes](../release.md), never by editing this record. Until the runner
   lands, the package has no edge at all.
3. Admission under [ADR-0061](0061-library-first-foundation-boundary-evolution.md)
   point 1:
   - Why reuse is expected: Agent Runtime and the Get Modular test project adopt
     v1.1 in the same train, Engineering Foundation's own checker is the first
     consumer, and further repositories adopt the standard by profile.
   - How the contract evolves: the input is declared facts (feature roots, role
     mapping, curated surfaces, republications, declared use edges, import
     records) and the output is diagnostics with stable codes plus per-feature
     metrics. The kernel reads no files, runs no parser and widens no policy.
     It exports the identity and digest of the exact standard text it implements.
     A change of an API or of a diagnostic code is a minor release of the 0.x
     package with a changelog entry and a migration note.
   - Same-delivery validation: shared conformance fixtures (`./fixtures`) run as
     the kernel's own tests. The disposable project is the example tree of the
     standard, exported both as a module description and as materialized source
     files. The real consumer is the Engineering Foundation checker, see point 4.
4. Adoption sequence and its current state. Engineering Foundation's checker
   (`scripts/feature-modules/profile.mjs`, `dependencies.mjs`) already takes
   path containment, ownership-root overlap, v1 layer direction and cycle search
   from the kernel and has deleted its own copies. Two local strengthenings stay
   on top of the kernel: a contracts layer never imports another feature, and
   another module's exported API is judged with the inside-one-feature table.
   Not done yet: calling `checkFeatureModule` for deep-import and ownership
   rules. Engineering Foundation declares its features by layer roots per file or
   directory (several feature roots, role files such as `api.ts`), while the
   kernel derives ownership from a `features` directory and role directory names.
   Closing that gap needs a kernel input for profile-declared layer roots, a
   dual-run of the old and the new rules with a normalized comparison of rule,
   subject and location, and then deletion of the duplicated deep-import and
   ownership code, with the checker running `./fixtures` as its conformance test.
   This is a condition of the first publication: ADR-0061 requires the real
   consumer to be moved onto the contract before the package is released.
   Agent Runtime and the Get Modular test project adopt later and run the same
   fixtures; an old and a new implementation never stay side by side.
5. Engineering Foundation's own profile stays on v1 and declares no sub-feature.
6. Admission is for source use. The first publication of the new npm name is a
   separate owner step and this record authorizes none. The package is a bootstrap
   candidate in `architecture/foundation/npm-package-bootstrap.json` with no
   approval. The owner's bootstrap approval is needed right after the merge that
   adds the package, and before any `release:publish` of Engineering Foundation,
   because the closed publishable catalog now includes it.

## Consequences

- One implementation of the nested-feature rules, with one set of fixtures that
  every adopting checker runs.
- v1.1 can change while it settles without an Engineering Foundation major.
- What remains for the runner: feature root discovery and import reading
  through the public source graph, growth warnings through the budgets, the peer
  dependency and the implemented status of the edge in point 2.
- What remains for the real consumer: the kernel input for profile-declared
  layer roots and the move of deep-import and ownership checks of point 4.
