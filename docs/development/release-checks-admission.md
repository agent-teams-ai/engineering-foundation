# Release Checks source admission

`@agent-teams/release-checks` is an independent development library admitted by
[ADR-0068](../decisions/0068-release-checks-package-admission.md) under
[ADR-0061](../decisions/0061-library-first-foundation-boundary-evolution.md).
The [accepted delivery plan](release-checks-delivery-plan.md) and
[review record](../research/release-checks-plan-review.md) retain the completed
I1-I3 and C1-C3 rounds. This note distinguishes source work from publication
and consumer adoption. The [implementation qualification record](../research/release-checks-implementation-review.md)
tracks concrete code corrections, executed checks and final delivery evidence.

## Contract and owners

The public root exports `checkReleaseCandidate` and its concrete types. The
deliberate `./conformance` entry exports shared data with independent expected
outcomes, diagnostic codes and package changes. Both entries are pure, bounded
and deterministic. The package has no runtime, peer or optional dependency.
Its sole development dependency is the repository-catalog TypeScript compiler,
reusing existing exact clean-stage compiler custody; installed consumers get
no transitive compiler or parser. It introduces no Foundation root
facade, capability or consumer runtime dependency.

The package checks normalized accepted inputs against observed output. It
validates complete package and intention relationships, exact engine-planned
versions, full version-only manifests and the classified complete diff. It
does not generate a plan, choose a version, infer dependency rewrites, read a
repository, authenticate facts or authorize effects.

Foundation's existing release Hosts retain source and engine custody, official
Changesets collection, independent candidate reads, prerelease bookkeeping,
changelog and API policy, locks and publication. Its source-built adapter
replaces the transferred pure comparisons; it does not wrap and retain their
duplicate implementation. Get Modular and node-or-bun own their adapters and
adopt exact supported coordinates only after registry proof.

## Admission and qualification evidence

| Claim | Status and authority |
| --- | --- |
| Plan accepted before implementation | Completed I1-I3 and C1-C3, retained review record |
| Actual pinned engine behavior | P0 qualified 14 disposable fixtures with Changesets 2.31.1/3.0.2; report digest retained in the review record |
| Pure source and common fixtures | Implemented in one `candidate-checking` feature; focused tests must qualify the final source |
| Real Foundation consumer | Source-built release Hosts adopt the contract; final-head Host conformance and tamper checks remain required |
| Packed installed consumer | Focused actual qualification passed: two independent clean-stage builds produced identical archives; the installed pnpm consumer passed native TypeScript 7.0.2 and all 12 common runtime cases through both public entries |
| Hermetic registry consumer | The same qualified archive was published only to disposable no-uplink Verdaccio and installed by exact version with npm; public typing and all 12 runtime cases passed with matching archive integrity. Existing `npm-foundation` qualification invokes the same probe |
| Complete inventories | Catalog, strict projects, source/feature/quality profiles and complete Linux/Windows/coverage inventories include the package and tests |
| Initial typed baseline | Existing native promotion owner created only `release-checks.json` at `0.0.0`; the complete nine-package typed and artifact checks passed and all 13 historical baseline files retained their exact hashes |
| Namespace bootstrap | Exact Ubuntu writer tree/SRI reviewed and approved on 2026-10-23; current-head writer reproduction, maintainer readiness and protected publication remain pending |
| Supported release and external consumers | Pending exact protected publication, registry readback and separate installed consumer evidence |

The retained [installed qualification report](../research/evidence/release-checks/p1-installed-qualification.json)
has SHA-256
`e63b69ec6ec35d9bf4118f1e9e5da826006e69f16e8323441a685877fd552fd5`.
It records the actual Node 26.11.1 run and qualified archive SHA-256
`4c46ed8e2aa0cdd24e2b6b3d45acdf22f0614a777f9baccdf687f0630a55a027`.
The installed lock closures contain only release-checks, proving that the
development compiler is not installed transitively. Both public runtime
exports, package identity, exact version, native declaration consumption and
blocked private deep imports are checked. This is focused source-artifact
qualification; it is not final-head full CI, public npm publication or external
Host adoption evidence.

The P0 engine evidence preserves actual direct/dependent intent links and exact
versions. Both engines retain GM's symbolic `workspace:*` and `workspace:^`
manifest strings, but produce different peer-dependent versions. The existing
FMS `workspace:^1.8.0` floor survives an in-range Foundation release; an actual
Foundation major rewrites the peer and is outside the version-only admission.
Explicit `none` records need no edit. Ignored/private intention membership does
not imply consumption. A real mixed release consumes its qualified empty
housekeeping files while retaining ignored and non-versioned private files.
No-release Hosts stop before version generation.

The [initial API evidence](../research/evidence/release-checks/p1-initial-api-baseline.json)
records the actual create-only write and subsequent complete nine-package
compatibility check. The production configuration was not reduced or edited
for generation. The write target was only the new initial anchor, derived from
that configuration, and the existing promoter enforced the initial `0.0.0`
manifest, minor Changeset and absent preimage. The new baseline SHA-256 is
`9b02f3b4860b8f9f39eaf175d37c49c0e1678f492aea620d0e6053120b37e414`.
At the original source base, the normal all-package release promoter rejected
the preexisting Repository Mutation API addition at the same version. Its minor
intent was `.changeset/atomic-adr-baseline-replacement.md`. That rejection was
preserved: no old baseline or unrelated manifest was advanced to create the
new initial anchor. The initial record describes that exact historical run.

Protected main subsequently advanced to
`4ca4ad30b1efc5e3b43a2c012348ea8afea21864`, consuming seven existing intents and
publishing the source versions for Foundation 1.10.2 and its companion packages.
The implementation branch incorporates that owner release and retains all its
baseline, manifest, changelog and Bun-lock bytes. Those upstream baseline
promotions are distinct from the initial-admission evidence above. The
2026-10-23 integration advances to main
`17520f7d84d364f5bb40195785c2b7a9269663a0`, preserving released Stack Toolchain
`0.1.0`, its bootstrap recovery and all accepted main ADRs. Release-checks uses
ADR-0068; prior branch records ADR-0064 and ADR-0067 remain in Git history.
The incoming main keeps accepted ADR-0067, the Stack Toolchain command catalog,
Foundation 3 intent, and the complete toolchain-backed quality scope. Fresh final PR
qualification must use the integrated head and actual current base, retaining
consumed intents as history and never relabeling earlier CI.

## Source and publication hold

The source manifest begins at `0.0.0` and a minor Changeset lets the existing
engine derive supported `0.1.0`. This is not an npm publication. The public
catalog and bootstrap entry intentionally block **all ordinary
Foundation publication** until the existing bootstrap completes.

Pre-merge npm provider readiness remains unresolved. Cloudflare blocked the
interactive account surface during the original preflight; on 2026-10-23 the
connected-browser runtime instead reported that the originating browser context
was unavailable. Neither observation proves an available maintainer session.
Finish source, review and CI preparation while keeping admission unmerged until
that existing readiness requirement is established. Do not enable bootstrap or
create a timed token early.

The exact Ubuntu `linux-bootstrap-evidence` candidate from full PR CI run
`39664614732`, attempt 2, was downloaded and reviewed on 2026-10-23. The
[retained review](../research/evidence/release-checks/p1-ubuntu-writer-review-20261023.json)
binds artifact `12376897004`, its receipt, manifest, all 40 archive entries,
package tree and SRI. An independent reviewer recomputed the content bindings.
The catalog approval records that exact tree/SRI; every nonmanifest payload
byte matches the current unchanged package tree and build.

This reviewed target does not qualify the integrated source. Final-head/current-base
full CI must reproduce the approved archive under the current writer inputs,
including the intervening packaging hook change. Changed output requires new
reviewed evidence. Complete independent final review before the canonical owner
merge. Maintainer readiness remains a separate pre-merge prerequisite.

P3 revalidates that reviewed approval and fresh protected-main CI with all five
bootstrap proof contexts before using the existing protected namespace workflow,
reviewed writer archive SRI and package tree, one-package short-lived token,
signature/provenance/deprecation readback and cleanup. Only after its immutable
deprecated `0.0.0` baseline exists may the normal Changesets owner-PR flow
publish supported `0.1.0`. The supported artifact then needs exact public
registry and installed-consumer qualification before external adoption.
