---
id: ADR-0064
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0064: Release Checks Package Admission

Status: Accepted. Decision owner: Product owner. Date: 2026-10-20.

## Context

Foundation, Get Modular and node-or-bun need to check generated release
candidates against accepted source inputs and the exact plan of their existing
version engine. Foundation already owns pure manifest equality and release
coverage checks inside its repository scripts. Keeping those shared relations
inside each Host would duplicate the same reason to change; moving provider
authority or version calculation into a shared release manager would cross
their ownership boundaries.

The Product owner authorized the bounded
[delivery plan](../development/release-checks-delivery-plan.md). Three sequential
improvement rounds and three independent critical reviews accepted its scope
before implementation. [ADR-0061](0061-library-first-foundation-boundary-evolution.md)
admits expected reuse with shared conformance, a disposable project and at least
one real consumer in the same delivery.

## Decision

1. Add `@agent-teams/release-checks` as an independent 0.x development package
   under `packages/release-checks`. It is outside the documentation Cohort.
   This record adds only this node, with no package dependency edges, to the
   target graph of
   [ADR-0043](0043-new-only-portable-documentation-package-boundary.md), as already
   amended by
   [ADR-0062](0062-feature-module-standard-package-admission.md). It does not
   supersede either record as a whole; every other accepted edge remains in
   force. Ownership and release documents record implemented status.
2. The package owns one pure operation, `checkReleaseCandidate`, runtime
   validation of its normalized facts, deterministic coded diagnostics and
   shared conformance cases. `.` and `./conformance` import no external package
   or Node built-in. The manifest declares no runtime, peer or optional
   dependency. Its only development dependency is the repository's exact
   catalog-pinned TypeScript compiler, which the existing clean-stage compiler
   custody snapshots. Consumers install no transitive compiler or parser.
   Foundation gains no public capability, root facade or package dependency on
   this leaf. Its private release Hosts source-build the workspace entrypoint.
3. The contract compares an accepted complete workspace inventory, full
   semantic manifests, engine/config/source bindings, pending intentions,
   qualified exact plan and consumption expectation with independently
   observed candidate manifests, intentions and complete classified diff.
   The library never calculates a version or a dependency range. Changesets
   remains the sole version and propagation engine. Full manifest equality
   permits only the exact planned version edit in this admission.
4. Every Host retains filesystem and Git observation, physical execution
   custody, source/PR/CI authentication, official engine invocation and
   normalization, output path classification, locks, changelogs, API history,
   provider effects and release authority. A passing relation authenticates
   none of its supplied facts and grants no merge or publication authority.
   Explicit `none`, ignored, private and absent-version records remain visible;
   raw intention membership is distinct from qualified consumption. Existing
   no-release Hosts terminate without generating a candidate. A real release
   may consume its qualified empty housekeeping intentions, with no permission
   for unrelated drift or new prerelease/maintenance behavior.
5. Expected reuse is concrete: Foundation's existing release guards and
   pre-mutation version route are the first real consumer; Get Modular and
   node-or-bun adopt the same public API and conformance through their own
   development adapters after exact registry qualification. The same delivery
   includes disposable installed consumers for both `.` and `./conformance`,
   kernel conformance tests and a conformance test in every adopting Host.
   Foundation removes the superseded pure comparisons during adoption while
   retaining their Host policy. External adoption status stays separately
   recorded; source admission is not proof that a consumer has switched.
6. Begin at source version `0.0.0` with a minor Changeset for the first
   supported `0.1.0`. The initial API baseline is extracted from the actual
   native declarations through the existing create-only bootstrap. During
   MVP, breaking API or diagnostic changes are 0.x minor releases with a
   changelog entry and migration guide; patches preserve meaning. Shared
   fixtures evolve with that declared contract, not with provider-specific
   DTOs or engine heuristics.
7. This record authorizes source admission only. It grants no bootstrap
   approval or publication authority. The candidate profile and reviewed
   artifact approval belong only in
   `architecture/foundation/npm-package-bootstrap.json`. Inclusion in the
   closed public catalog deliberately blocks every ordinary Foundation
   publication until the existing namespace bootstrap has reviewed approval
   and its immutable deprecated `0.0.0` baseline. Pre-merge provider readiness
   must be established; missing interactive npm access leaves admission
   unmerged. Short-lived credentials are provisioned only at their actual
   bootstrap step. [ADR-0044](0044-registry-neutral-npm-bootstrap-tags.md) and
   the existing protected workflow retain all tag, provenance and cleanup
   requirements.

## Consequences

- A dependency-free library shares release relations without installing the
  Foundation compiler stack in other tooling consumers.
- Current-source builds need no previously published copy of this package.
- Installed packed and hermetic-registry qualification exercise the public
  API and common cases through the existing qualification phases.
- A future engine-required dependency rewrite is rejected by this
  version-only contract until its owner separately admits and qualifies it.
- Publication and external consumer adoption remain pending until their
  existing protected release and installed-consumer evidence is complete.

## Rejected alternatives

- A Foundation root export or capability, which couples a small comparator to
  Foundation's compiler and capability runtime.
- A second version/propagation engine or a generic release orchestrator.
- Provider/Changesets DTOs, Git access, arbitrary rewrite rules or credentials
  in the pure package.
- Leaving duplicate pure implementation in an adopting Host, or claiming that
  catalog membership alone proves an installed package works.
- Editing accepted package-boundary or bootstrap decisions to manufacture
  source or publication authority.
